"""Local durable runner. Claims server-approved jobs, journals writes, verifies and receipts.
An uncertain provider result is never automatically repeated.
"""

import contextlib, json, os, sqlite3, threading, time, uuid
from pathlib import Path
from .client import ClientError
from .profiles import root, read_profiles, save_profiles, source
from .connectors import adapter, validate, DestinationError
from .connectors.base import sha


class Ledger:
    def __init__(self):
        folder = root()
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = folder / "connector.sqlite3"
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        os.chmod(path, 0o600)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(
            """CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,source TEXT NOT NULL,destination TEXT NOT NULL,stage TEXT NOT NULL,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mappings(id TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS local_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);"""
        )
        self.db.commit()

    def close(self):
        self.db.close()

    def run(self, key):
        row = self.db.execute("SELECT * FROM runs WHERE id=?", (key,)).fetchone()
        return {**dict(row), "data": json.loads(row["data"])} if row else None

    def record(self, key, source_id, dest, stage, data):
        self.db.execute(
            "INSERT OR REPLACE INTO runs VALUES (?,?,?,?,?)",
            (key, source_id, dest, stage, json.dumps(data, ensure_ascii=False)),
        )
        self.db.commit()

    def previous(self, key):
        row = self.db.execute("SELECT data FROM mappings WHERE id=?", (key,)).fetchone()
        return json.loads(row["data"]) if row else None

    def mapped(self, key, result):
        self.db.execute(
            "INSERT OR REPLACE INTO mappings VALUES (?,?)",
            (key, json.dumps(result, ensure_ascii=False)),
        )
        self.db.commit()

    def executor(self):
        row = self.db.execute(
            "SELECT value FROM local_metadata WHERE key='executor'"
        ).fetchone()
        if row:
            return row["value"]
        value = "local-" + uuid.uuid4().hex
        self.db.execute("INSERT INTO local_metadata VALUES ('executor',?)", (value,))
        self.db.commit()
        return value


@contextlib.contextmanager
def execution_lock():
    """No simultaneous local writes. Unix and Windows lock APIs release on process exit."""
    folder = root()
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(folder / "connector.lock", "a+b") as f:
        os.chmod(folder / "connector.lock", 0o600)
        try:
            if os.name == "nt":
                import msvcrt

                f.seek(0)
                f.write(b"0")
                f.flush()
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise ClientError("runner_busy", "已有本地连接器正在执行") from None
        try:
            yield
        finally:
            if os.name == "nt":
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(f, fcntl.LOCK_UN)


class Heartbeat:
    def __init__(self, client, plan, lease):
        self.client, self.plan, self.lease = client, plan, lease
        self.stop_event = threading.Event()
        self.cancelled = False
        self.error = False

    def run(self):
        while not self.stop_event.wait(30):
            try:
                result = self.client.request(
                    "/api/v1/export-plans/" + self.plan + "/heartbeat",
                    {"lease": self.lease},
                )
                self.cancelled = result["status"] == "cancel_requested"
            except ClientError:
                self.error = True
                return

    def __enter__(self):
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.stop_event.set()
        self.thread.join(timeout=2)


def destination(name):
    value = read_profiles().get("destinations", {}).get(name)
    if not value:
        raise ClientError("destination_missing", "请先配置本地目的地")
    return value


def run_plan(client, plan_id, destination_name, reconcile=False, pull=False):
    cap = client.capabilities()
    source_id = sha(client.url + "|" + cap["subject"])
    run_id = sha(source_id + "|" + plan_id)
    with execution_lock():
        ledger = Ledger()
        try:
            old = ledger.run(run_id)
            if old and old["destination"] != destination_name:
                raise ClientError("target_mismatch", "这个计划已经绑定其他本地目的地")
            if old and old["stage"] == "receipted" and not pull:
                return {
                    "plan_id": plan_id,
                    "status": "already_completed",
                    "receipt": old["data"]["receipt"],
                }
            if old and not reconcile and not pull:
                raise ClientError(
                    "unknown_result",
                    "本地已有执行记录；使用 reconcile 核对结果，不能重复写入",
                )
            if pull:
                if (
                    not old
                    or not old["data"].get("result")
                    or not old["data"].get("metadata")
                ):
                    raise ClientError(
                        "missing_receipt", "没有本地目标映射，无法读取外部修改"
                    )
                target = adapter(destination(destination_name))
                meta = old["data"]["metadata"]
                target.resolve(meta)
                text = target.read_back(old["data"]["result"])
                if len(text) > 100000:
                    raise ClientError(
                        "budget_exceeded", "外部正文过长，请先在目的地整理"
                    )
                ref = meta["source_refs"][0]
                current = client.read(ref["item_id"])
                return client.propose(
                    {
                        "space_id": meta["space_id"],
                        "action": "append_reply",
                        "target_item_id": ref["item_id"],
                        "base_revision": current["revision"],
                        "content": text,
                        "source_refs": [
                            {"item_id": ref["item_id"], "revision": current["revision"]}
                        ],
                        "title": "目的地修改 · 待采纳",
                    },
                    "pull-" + sha(text + "|" + plan_id),
                )
            package = client.request("/api/v1/export-plans/" + plan_id + "/package")
            package["_source_url"] = client.url
            target = adapter(destination(destination_name))
            target.resolve(package)
            mapping_key = sha(
                source_id
                + "|"
                + destination_name
                + "|"
                + json.dumps(
                    {
                        "sources": sorted(
                            {r["item_id"] for r in package["package"]["source_refs"]}
                        ),
                        "fields": package["package"]["fields"],
                        "format": package["format"],
                    },
                    sort_keys=True,
                )
            )
            if reconcile:
                if (
                    not old
                    or not old["data"].get("result")
                    or not old["data"].get("lease")
                ):
                    raise ClientError(
                        "manual_reconciliation_required",
                        "缺少已确认的目标 ID；请在目的地核对，不会重新创建",
                    )
                result = old["data"]["result"]
                verification = target.verify(package, result)
                if not verification["read_back_verified"]:
                    return {
                        "plan_id": plan_id,
                        "status": "unknown_result",
                        "verification": verification,
                    }
                receipt = target.receipt(package, result, verification)
                response = client.request(
                    "/api/v1/export-plans/" + plan_id + "/receipts",
                    {"lease": old["data"]["lease"], **receipt},
                )
                ledger.mapped(mapping_key, result)
                ledger.record(
                    run_id,
                    source_id,
                    destination_name,
                    "receipted",
                    {**old["data"], "receipt": response},
                )
                return response
            previous = ledger.previous(mapping_key)
            decision = {"action": "not_planned"}
            claim = client.request(
                "/api/v1/export-plans/" + plan_id + "/claim",
                {"executor_id": ledger.executor()},
            )
            state = {
                "lease": claim["lease"],
                "plan_id": plan_id,
                "decision": decision,
                "result": None,
                "metadata": {
                    k: package[k] for k in ["space_id", "destination", "target_id"]
                }
                | {"source_refs": package["package"]["source_refs"]},
            }
            ledger.record(run_id, source_id, destination_name, "claimed", state)

            def journal(stage, result):
                state["result"] = {**(state.get("result") or {}), **result}
                state["stage"] = stage
                ledger.record(run_id, source_id, destination_name, stage, state)
                if heartbeat.cancelled or heartbeat.error:
                    raise DestinationError(
                        "execution_paused",
                        "执行已被取消或授权连接失效",
                        "apply",
                        uncertain=True,
                    )

            with Heartbeat(client, plan_id, claim["lease"]) as heartbeat:
                try:
                    state["decision"] = target.plan(package, previous)
                    if target.capabilities.get("attachments"):
                        attachments = []
                        seen_attachments = set()
                        attachment_bytes = 0
                        for f in package["package"]["fragments"]:
                            if f["part_type"] != "attachment_metadata":
                                continue
                            metadata = json.loads(f["text"])
                            if metadata["id"] in seen_attachments:
                                continue
                            seen_attachments.add(metadata["id"])
                            if len(seen_attachments) > 100:
                                raise DestinationError(
                                    "attachment_budget",
                                    "一次最多沉淀 100 个附件",
                                    "fetch",
                                )
                            if metadata.get("available") is True:
                                attachments.append(
                                    {
                                        "id": metadata["id"],
                                        "name": metadata["name"],
                                        "bytes": client.request(
                                            "/api/v1/files/"
                                            + metadata["id"]
                                            + "?item_id="
                                            + f["item_id"]
                                            + "&revision="
                                            + str(f["revision"]),
                                            binary=True,
                                        ),
                                    }
                                )
                                attachment_bytes += len(attachments[-1]["bytes"])
                                if attachment_bytes > 100 * 1024 * 1024:
                                    raise DestinationError(
                                        "attachment_budget",
                                        "本次附件超过 100 MiB，请缩小选择范围",
                                        "fetch",
                                    )
                        package["_attachments"] = attachments
                    result = target.apply(package, previous, journal)
                    state["result"] = result
                    journal("verifying", result)
                    verification = target.verify(package, result)
                    receipt = target.receipt(package, result, verification)
                    ledger.mapped(mapping_key, result)
                except (DestinationError, ClientError) as e:
                    uncertain = getattr(e, "uncertain", False) or state.get(
                        "stage"
                    ) in ("before_create", "before_write", "before_blocks")
                    # Once a remote object exists, preserve it and report partial rather than repeat its creation.
                    receipt = {
                        "status": (
                            "unknown_result"
                            if uncertain
                            else (
                                "partial"
                                if (state.get("result") or {}).get("id")
                                else "failed"
                            )
                        ),
                        "stage": getattr(e, "stage", "fetch"),
                        "destination_item_id": (state.get("result") or {}).get(
                            "id", ""
                        ),
                        "read_back_verified": False,
                        "warnings": [str(e)],
                    }
                state["receipt"] = receipt
                ledger.record(
                    run_id, source_id, destination_name, "receipt_pending", state
                )
                try:
                    response = client.request(
                        "/api/v1/export-plans/" + plan_id + "/receipts",
                        {"lease": claim["lease"], **receipt},
                    )
                except ClientError:
                    ledger.record(
                        run_id, source_id, destination_name, "receipt_pending", state
                    )
                    raise ClientError(
                        "receipt_pending",
                        "目的地执行已记录，但服务端回执未确认；请用 reconcile 核对",
                    ) from None
                state["receipt"] = response
                ledger.record(
                    run_id,
                    source_id,
                    destination_name,
                    (
                        "receipted"
                        if receipt["status"] == "completed"
                        else receipt["status"]
                    ),
                    state,
                )
                return response
        finally:
            ledger.close()


def command(args):
    if args.action == "configure":
        from .cli import payload

        profile = validate(payload(args.file))
        profiles = read_profiles()
        profiles["destinations"][args.name] = profile
        save_profiles(profiles)
        return {
            "ok": True,
            "destination": args.name,
            "kind": profile["kind"],
            "credentials": "local_reference_only",
        }
    if args.action == "probe":
        return adapter(destination(args.name)).probe()
    client = source(args.profile)
    if args.action in ("run", "reconcile", "pull"):
        return run_plan(
            client,
            args.plan,
            args.destination,
            args.action == "reconcile",
            args.action == "pull",
        )
    if not 5 <= args.interval <= 3600:
        raise ClientError("invalid_input", "检查间隔需为 5 至 3600 秒")
    while True:
        profiles = read_profiles().get("destinations", {})
        results = []
        for job in client.request("/api/v1/jobs")["jobs"]:
            names = [
                n
                for n, p in profiles.items()
                if p["kind"] == job["destination"]
                and p["target_id"] == job["target_id"]
            ]
            if len(names) != 1:
                results.append({"id": job["id"], "status": "waiting_local_profile"})
                continue
            try:
                results.append(
                    {"id": job["id"], **run_plan(client, job["id"], names[0])}
                )
            except ClientError as e:
                results.append(
                    {
                        "id": job["id"],
                        "status": "needs_attention",
                        "code": e.code,
                        "message": str(e),
                    }
                )
        if args.once:
            return {"runs": results, "runner": "local", "unconfigured_jobs": "pending"}
        print(json.dumps({"runs": results}, ensure_ascii=False), flush=True)
        time.sleep(args.interval)
