"""Human adoption, approved exports and durable connector work queues."""

import hashlib, json, secrets, time, uuid
from datetime import datetime, timezone, timedelta
import kbase
from access import APIError, Identity, fail, integer, text, strings, safe_url
from knowledge import KnowledgeService


def valid_grant(db, api, ident):
    row = db.execute("SELECT * FROM access_grants WHERE id=?", (ident,)).fetchone()
    if not row or not row["enabled"] or row["expires"] <= kbase.stamp():
        fail(403, "grant_revoked", "来源授权已失效，不能继续执行")
    account = db.execute(
        "SELECT disabled FROM accounts WHERE id=?", (row["owner"],)
    ).fetchone()
    if (
        account
        and account["disabled"]
        or not account
        and db.execute("SELECT 1 FROM accounts LIMIT 1").fetchone()
    ):
        fail(403, "grant_revoked", "来源账号不可用")
    return Identity(db, api, row["owner"], row)


class TransferService:
    def __init__(self, db, api, identity):
        self.db, self.api, self.identity = db, api, identity
        self.knowledge = KnowledgeService(db, api, identity)

    def references(self, refs):
        if not isinstance(refs, list) or len(refs) > 3000:
            fail(400, "invalid_input", "来源列表无效")
        result = []
        for ref in refs:
            if not isinstance(ref, dict):
                fail(400, "invalid_input", "来源格式无效")
            snapshot = self.knowledge.snapshot(ref.get("item_id"), ref.get("revision"))
            parts = {
                f["part_id"]
                for f in self.knowledge.fragments(
                    snapshot, self.identity.fields(), False
                )[0]
            }
            if ref.get("part_id") and ref["part_id"] not in parts:
                fail(404, "not_found", "来源片段不存在或不可访问")
            result.append(
                {
                    "item_id": snapshot["item"]["id"],
                    "revision": snapshot["revision"],
                    **({"part_id": ref["part_id"]} if ref.get("part_id") else {}),
                }
            )
        return result

    def propose(self, data, direct=False):
        self.identity.require("knowledge:write" if direct else "proposals:create")
        allowed = {
            "space_id",
            "action",
            "target_item_id",
            "base_revision",
            "content",
            "title",
            "source_refs",
            "model_attribution",
        }
        if not isinstance(data, dict) or set(data) - allowed:
            fail(400, "invalid_input", "建议只接受知识内容与来源，不接受凭据")
        space = self.identity.space(data.get("space_id", "personal"))
        self.identity.can_write(space)
        action = data.get("action")
        if action not in [
            "create_note",
            "append_reply",
            "suggest_understanding",
            "suggest_experience",
        ]:
            fail(400, "invalid_input", "建议动作无效")
        if (
            not isinstance(data.get("source_refs", []), list)
            or len(data.get("source_refs", [])) > 100
        ):
            fail(400, "invalid_input", "建议最多引用 100 个来源")
        content = text(data.get("content"), "内容", 100000)
        target = data.get("target_item_id")
        if action != "create_note":
            doc = self.identity.document(target)
            if (doc.get("space_id") or "personal") != space:
                fail(400, "invalid_input", "目标必须属于选定空间")
            revision = kbase.current_revision(self.db, target)
            if (
                data.get("base_revision") is not None
                and data["base_revision"] != revision
            ):
                fail(409, "revision_conflict", "原文已更新，请重新整理")
        else:
            revision = None
        attribution = data.get("model_attribution", {})
        if not isinstance(attribution, dict) or set(attribution) - {
            "requested_model",
            "response_model",
            "generated_at",
        }:
            fail(400, "invalid_input", "模型归属只能包含模型与时间")
        if any(not isinstance(v, str) or len(v) > 300 for v in attribution.values()):
            fail(400, "invalid_input", "模型归属格式无效")
        payload = {
            "space_id": space,
            "action": action,
            "target_item_id": target,
            "base_revision": revision,
            "content": content,
            "title": str(data.get("title", ""))[:240],
            "source_refs": self.references(data.get("source_refs", [])),
            "model_attribution": attribution,
        }
        ident = uuid.uuid4().hex
        self.db.execute(
            "INSERT INTO knowledge_proposals(id,owner,grant_id,space,payload,status,created,updated) VALUES (?,?,?,?,?,?,?,?)",
            (
                ident,
                self.identity.actor,
                self.identity.grant["id"] if self.identity.grant else None,
                space,
                kbase.encoded(payload),
                "awaiting_approval",
                kbase.stamp(),
                kbase.stamp(),
            ),
        )
        self.identity.audit(
            "knowledge.propose",
            [r["item_id"] for r in payload["source_refs"]],
            space=space,
        )
        return {
            "id": ident,
            "status": "awaiting_approval",
            "review_url": "/?review=" + ident,
            "content_sha256": kbase.digest(payload),
        }

    def proposal(self, ident, review=False):
        row = self.db.execute(
            "SELECT * FROM knowledge_proposals WHERE id=?", (ident,)
        ).fetchone()
        if not row:
            fail(404, "not_found", "建议不存在或不可访问")
        if self.identity.grant and row["grant_id"] != self.identity.id:
            fail(404, "not_found", "建议不存在或不可访问")
        payload = json.loads(row["payload"])
        machine = (
            self.db.execute(
                "SELECT * FROM service_accounts WHERE id=?", (row["owner"],)
            ).fetchone()
            if self.db.execute(
                "SELECT 1 FROM sqlite_master WHERE name='service_accounts'"
            ).fetchone()
            else None
        )
        manager = (
            machine
            and self.api.role_for(self.db, machine["space"], self.identity.actor)
            in ("owner", "admin")
            and not self.identity.grant
        )
        if row["owner"] != self.identity.actor and not manager:
            target = payload.get("target_item_id")
            doc = self.identity.document(target) if target else None
            if not doc or doc["owner_id"] != self.identity.actor:
                fail(404, "not_found", "建议不存在或不可访问")
        self.identity.can_write(payload["space_id"])
        return row, payload

    def adopt(self, ident, data):
        if self.identity.grant:
            fail(403, "interactive_required", "Agent 不能批准自己的建议")
        row, payload = self.proposal(ident, True)
        if row["status"] == "completed":
            return json.loads(row["result"])
        if row["status"] != "awaiting_approval":
            fail(409, "invalid_state", "建议已经处理")
        writer = (
            valid_grant(self.db, self.api, row["grant_id"])
            if row["grant_id"]
            else Identity(self.db, self.api, row["owner"])
        )
        writer.can_write(payload["space_id"])
        TransferService(self.db, self.api, writer).references(payload["source_refs"])
        if (
            payload.get("target_item_id")
            and kbase.current_revision(self.db, payload["target_item_id"])
            != payload["base_revision"]
        ):
            fail(409, "revision_conflict", "原文已更新，请重新核对建议")
        payload = {
            **payload,
            "content": text(
                data.get("content", payload["content"]), "收录内容", 100000
            ),
        }
        approved = kbase.digest(payload)
        result = self.apply_payload(writer, payload, reviewer=self.identity.actor)
        self.db.execute(
            "UPDATE knowledge_proposals SET status=?,payload=?,approved_hash=?,approved_by=?,updated=?,result=? WHERE id=?",
            (
                "completed",
                kbase.encoded(payload),
                approved,
                self.identity.actor,
                kbase.stamp(),
                kbase.encoded(result),
                ident,
            ),
        )
        self.identity.audit(
            "knowledge.adopt", [result["item_id"]], space=payload["space_id"]
        )
        return result

    def apply_payload(self, writer, payload, reviewer=None):
        space = payload["space_id"]
        writer.can_write(space)
        actor = writer.actor
        profile = self.db.execute(
            "SELECT data FROM profiles WHERE id=?", (actor,)
        ).fetchone()
        name = json.loads(profile["data"]).get("display_name", "") if profile else ""
        ident = uuid.uuid4().hex
        ai = {
            "requestedModel": payload["model_attribution"].get("requested_model"),
            "responseModel": payload["model_attribution"].get("response_model"),
            "at": kbase.stamp(),
            "sources": payload["source_refs"],
            "adopted_by": reviewer or actor,
        }
        action = payload["action"]
        if action in ["append_reply", "suggest_understanding"]:
            parent = writer.document(payload["target_item_id"])
            reply = {
                "id": ident,
                "item_id": parent["id"],
                "owner_id": actor,
                "owner_name": name,
                "body": payload["content"],
                "created_at": kbase.stamp(),
                "updated_at": kbase.stamp(),
                "is_progress": False,
                "atts": [],
                "ai": ai,
                "agent_origin": True,
            }
            self.api.validate_doc(reply, "reply")
            self.db.execute(
                "INSERT INTO documents VALUES (?,?,?,?)",
                (ident, actor, "reply", kbase.encoded(reply)),
            )
            if action == "suggest_understanding":
                if reviewer != parent["owner_id"]:
                    fail(403, "scope_required", "只有原文作者可以采纳为当前理解")
                parent["und"] = ident
                parent["und_hist"] = [
                    *(parent.get("und_hist") or []),
                    {"r": ident, "t": int(time.time() * 1000)},
                ]
                parent["updated_at"] = kbase.stamp()
                self.db.execute(
                    "UPDATE documents SET data=? WHERE id=?",
                    (kbase.encoded(parent), parent["id"]),
                )
            result = {"item_id": parent["id"], "reply_id": ident}
        else:
            kind = "experience" if action == "suggest_experience" else "note"
            inherited_topics = []
            for topic_id in writer.policy["topic_ids"] if writer.policy else []:
                topic = writer.document(topic_id)
                if (
                    topic.get("type") == "topic"
                    and (topic.get("space_id") or "personal") == space
                ):
                    inherited_topics.append(topic_id)

            item = {
                "id": ident,
                "owner_id": actor,
                "owner_name": name,
                "type": kind,
                "title": payload.get("title", ""),
                "body": payload["content"],
                "created_at": kbase.stamp(),
                "updated_at": kbase.stamp(),
                "space_id": None if space == "personal" else space,
                "atts": [],
                "topic_ids": inherited_topics,
                "ai": ai,
                "agent_origin": True,
            }
            if kind == "experience":
                item.update(
                    {
                        "exp_st": "需要再确认",
                        "exp_src": payload.get("target_item_id"),
                        "validation": {"status": "unverified"},
                    }
                )
            self.api.validate_doc(item, "item")
            self.db.execute(
                "INSERT INTO documents VALUES (?,?,?,?)",
                (ident, actor, "item", kbase.encoded(item)),
            )
            if writer.grant and not writer.policy["dynamic_membership"]:
                policy = dict(writer.policy)
                policy["captured_item_ids"] = [*policy["captured_item_ids"], ident]
                self.db.execute(
                    "UPDATE access_grants SET policy=? WHERE id=?",
                    (kbase.encoded(policy), writer.id),
                )
            result = {"item_id": ident}
        kbase.project_events(self.db)
        result["revision"] = kbase.current_revision(self.db, result["item_id"])
        return result

    def direct_write(self, data):
        self.identity.require("knowledge:write")
        if not self.identity.grant:
            fail(400, "invalid_input", "直接 Agent 写入需要独立的访问授权")
        action = data.get("action")
        if action not in self.identity.policy["allowed_write_actions"]:
            fail(403, "scope_required", "动作未获授权")
        today = kbase.stamp()[:10]
        count = self.db.execute(
            "SELECT COUNT(*) AS n FROM access_audit WHERE grant_id=? AND action='knowledge.write' AND allowed=1 AND at>=?",
            (self.identity.id, today),
        ).fetchone()["n"]
        if count >= self.identity.policy["max_new_items_per_day"]:
            fail(429, "rate_limited", "已达到本授权的每日写入上限")
        proposal = self.propose(data, direct=True)
        row = self.db.execute(
            "SELECT payload FROM knowledge_proposals WHERE id=?", (proposal["id"],)
        ).fetchone()
        result = self.apply_payload(self.identity, json.loads(row["payload"]))
        self.db.execute(
            "UPDATE knowledge_proposals SET status=?,result=?,updated=? WHERE id=?",
            ("completed", kbase.encoded(result), kbase.stamp(), proposal["id"]),
        )
        self.identity.audit(
            "knowledge.write", [result["item_id"]], space=data.get("space_id")
        )
        return result

    def prepare_export(self, data, auto=False):
        if "allow_update" in data and not isinstance(data["allow_update"], bool):
            fail(400, "invalid_input", "更新权限必须为明确的布尔值")
        space = self.identity.space(data.get("space_id", "personal"))
        destination = data.get("destination")
        if destination not in ["ima", "feishu", "obsidian", "portable"]:
            fail(400, "invalid_input", "目的地无效")
        self.identity.can_export(space, destination)
        target = text(data.get("target_id"), "目标标识", 500)
        if any(c in target for c in ["\r", "\n"]):
            fail(400, "invalid_input", "目标标识无效")
        if data.get("snapshot_id"):
            row = self.db.execute(
                "SELECT data,owner,grant_id FROM knowledge_packages WHERE id=?",
                (data["snapshot_id"],),
            ).fetchone()
            if (
                not row
                or row["owner"] != self.identity.actor
                or self.identity.grant
                and row["grant_id"] != self.identity.id
            ):
                fail(404, "not_found", "知识包不存在或不属于当前授权")
            package = json.loads(row["data"])
            if package["space_id"] != space:
                fail(400, "invalid_input", "知识包不属于当前空间")
            self.identity.fields(package["fields"])
            self.references(package["source_refs"])
        else:
            package = self.knowledge.extract(
                {
                    **data.get("extraction", {}),
                    "space_id": space,
                    "purpose": "portable_export",
                }
            )
        if not package["fragments"]:
            fail(400, "invalid_input", "没有选中可沉淀的内容")
        format = data.get("format", "full_record")
        if format not in ["full_record", "edited_document"]:
            fail(400, "invalid_input", "版式无效")
        content = text(data.get("content", package["markdown"]), "沉淀内容", 100000)
        if auto and content != package["markdown"].strip():
            fail(400, "invalid_input", "自动规则不能批准 Agent 自行改写的稿件")
        attribution = data.get("model_attribution", {})
        if (
            not isinstance(attribution, dict)
            or set(attribution)
            - {"requested_model", "response_model", "generated_at", "output_status"}
            or any(not isinstance(v, str) or len(v) > 300 for v in attribution.values())
        ):
            fail(400, "invalid_input", "模型归属格式无效")
        payload = {
            "space_id": space,
            "destination": destination,
            "target_id": target,
            "format": format,
            "package": package,
            "content": content,
            "content_sha256": kbase.digest(content),
            "allow_update": bool(data.get("allow_update", False)),
            "title": str(data.get("title", "知识沉淀"))[:200],
            "model_attribution": attribution,
        }
        ident = uuid.uuid4().hex
        status = "approved" if auto else "awaiting_approval"
        self.db.execute(
            "INSERT INTO export_plans(id,owner,grant_id,space,data,status,approved_hash,created,updated) VALUES (?,?,?,?,?,?,?,?,?)",
            (
                ident,
                self.identity.actor,
                self.identity.grant["id"] if self.identity.grant else None,
                space,
                kbase.encoded(payload),
                status,
                kbase.digest(payload) if auto else None,
                kbase.stamp(),
                kbase.stamp(),
            ),
        )
        self.identity.audit(
            "export.prepare",
            [r["item_id"] for r in package["source_refs"]],
            space=space,
        )
        return {
            "id": ident,
            "status": status,
            "content_sha256": payload["content_sha256"],
            "review_url": "/?review=" + ident,
        }

    def plan(self, ident):
        row = self.db.execute(
            "SELECT * FROM export_plans WHERE id=?", (ident,)
        ).fetchone()
        if not row:
            fail(404, "not_found", "导出计划不存在或不可访问")
        if row["owner"] != self.identity.actor:
            machine = (
                self.db.execute(
                    "SELECT * FROM service_accounts WHERE id=?", (row["owner"],)
                ).fetchone()
                if self.db.execute(
                    "SELECT 1 FROM sqlite_master WHERE name='service_accounts'"
                ).fetchone()
                else None
            )
            if (
                self.identity.grant
                or not machine
                or self.api.role_for(self.db, machine["space"], self.identity.actor)
                not in ("owner", "admin")
            ):
                fail(404, "not_found", "导出计划不存在或不可访问")
        if (
            self.identity.grant
            and row["grant_id"]
            and row["grant_id"] != self.identity.id
        ):
            fail(404, "not_found", "导出计划不属于这个授权")
        data = json.loads(row["data"])
        self.identity.can_export(data["space_id"], data["destination"])
        self.identity.fields(data["package"]["fields"])
        self.references(data["package"]["source_refs"])
        if row["grant_id"]:
            origin = valid_grant(self.db, self.api, row["grant_id"])
            origin.can_export(data["space_id"], data["destination"])
            origin.fields(data["package"]["fields"])
            TransferService(self.db, self.api, origin).references(
                data["package"]["source_refs"]
            )
        return row, data

    def approve_export(self, ident, data):
        if self.identity.grant:
            fail(403, "interactive_required", "Agent 不能批准外发内容")
        row, payload = self.plan(ident)
        if row["status"] not in ["awaiting_approval", "approved"]:
            fail(409, "invalid_state", "任务已经开始或完成")
        for ref in payload["package"].get(
            "source_heads", payload["package"]["source_refs"]
        ):
            if kbase.current_revision(self.db, ref["item_id"]) != ref["revision"]:
                fail(409, "revision_conflict", "来源更新了，请重新生成预览")
        payload["content"] = text(
            data.get("content", payload["content"]), "沉淀内容", 100000
        )
        payload["content_sha256"] = kbase.digest(payload["content"])
        self.db.execute(
            "UPDATE export_plans SET status=?,data=?,approved_hash=?,updated=? WHERE id=?",
            (
                "approved",
                kbase.encoded(payload),
                kbase.digest(payload),
                kbase.stamp(),
                ident,
            ),
        )
        self.identity.audit(
            "export.approve",
            [r["item_id"] for r in payload["package"]["source_refs"]],
            space=payload["space_id"],
        )
        return {
            "id": ident,
            "status": "approved",
            "content_sha256": payload["content_sha256"],
        }

    def package(self, ident):
        row, data = self.plan(ident)
        if row["status"] not in ["approved", "running", "unknown_result", "completed"]:
            fail(409, "awaiting_approval", "外发内容尚未确认")
        if row["approved_hash"] != kbase.digest(data):
            fail(409, "revision_conflict", "审批稿件已变化")
        for ref in data["package"].get("source_heads", data["package"]["source_refs"]):
            if kbase.current_revision(self.db, ref["item_id"]) != ref["revision"]:
                fail(409, "revision_conflict", "来源已变化，需重新核对")
        return {"plan_id": ident, **data}

    def claim(self, ident, data):
        self.identity.require("exports:run")
        row, payload = self.plan(ident)
        self.package(ident)
        if row["status"] != "approved":
            fail(409, "invalid_state", "任务不能重复认领；未知结果请先核对")
        executor = text(data.get("executor_id"), "本地执行者", 120)
        lease = secrets.token_urlsafe(36)
        until = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
        self.db.execute(
            "UPDATE export_plans SET status=?,lease_hash=?,lease_until=?,executor=?,updated=? WHERE id=?",
            (
                "running",
                hashlib.sha256(lease.encode()).hexdigest(),
                until,
                executor,
                kbase.stamp(),
                ident,
            ),
        )
        return {
            "plan_id": ident,
            "lease": lease,
            "lease_until": until,
            "package": payload,
        }

    def lease(self, row, value):
        if (
            not value
            or not row["lease_hash"]
            or not secrets.compare_digest(
                row["lease_hash"], hashlib.sha256(value.encode()).hexdigest()
            )
        ):
            fail(403, "scope_required", "执行租约无效")

    def heartbeat(self, ident, data):
        row, payload = self.plan(ident)
        self.lease(row, data.get("lease"))
        if row["status"] not in ["running", "cancel_requested"]:
            fail(409, "invalid_state", "执行任务已失效")
        until = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
        self.db.execute(
            "UPDATE export_plans SET lease_until=?,updated=? WHERE id=?",
            (until, kbase.stamp(), ident),
        )
        return {"status": row["status"], "lease_until": until}

    def receipt(self, ident, data):
        self.identity.require("exports:run")
        row, payload = self.plan(ident)
        self.lease(row, data.get("lease"))
        if row["status"] == "completed":
            previous = json.loads(row["result"])
            if (
                data.get("destination_item_id", "") == previous["destination_item_id"]
                and data.get("status") == "completed"
            ):
                return previous
            fail(409, "invalid_state", "已完成的回执不能被覆盖")
        if row["status"] not in [
            "running",
            "unknown_result",
            "cancel_requested",
            "partial",
        ]:
            fail(409, "invalid_state", "任务不接受这个回执")
        status = data.get("status")
        if status not in [
            "completed",
            "partial",
            "failed",
            "unknown_result",
            "cancelled",
        ]:
            fail(400, "invalid_input", "回执状态无效")
        result = {
            "status": status,
            "verification": "runner_reported",
            "executor_id": row["executor"],
            "destination_item_id": str(data.get("destination_item_id", ""))[:500],
            "destination_url": safe_url(data.get("destination_url")),
            "approved_content_sha256": payload["content_sha256"],
            "observed_content_sha256": str(data.get("observed_content_sha256", ""))[
                :64
            ],
            "read_back_verified": data.get("read_back_verified") is True,
            "checked_at": kbase.stamp(),
            "stage": str(data.get("stage", "verify"))[:30],
            "warnings": [str(x)[:500] for x in data.get("warnings", [])[:20]],
        }
        self.db.execute(
            "UPDATE export_plans SET status=?,result=?,updated=? WHERE id=?",
            (status, kbase.encoded(result), kbase.stamp(), ident),
        )
        self.identity.audit(
            "export.receipt",
            [r["item_id"] for r in payload["package"]["source_refs"]],
            space=payload["space_id"],
        )
        return result

    def list_operations(self):
        proposals = []
        for row in self.db.execute(
            "SELECT * FROM knowledge_proposals ORDER BY created DESC LIMIT 300"
        ):
            try:
                accessible, payload = self.proposal(row["id"])
                proposals.append(
                    {
                        "id": row["id"],
                        "owner": row["owner"],
                        "status": row["status"],
                        "created": row["created"],
                        "data": payload,
                        "result": json.loads(row["result"]) if row["result"] else None,
                    }
                )
            except APIError:
                pass
        plans = []
        for row in self.db.execute(
            "SELECT * FROM export_plans ORDER BY created DESC LIMIT 200"
        ):
            try:
                self.plan(row["id"])
                data = json.loads(row["data"])
                plans.append(
                    {
                        "id": row["id"],
                        "status": row["status"],
                        "created": row["created"],
                        "data": (
                            data
                            if not self.identity.grant
                            else {
                                k: data[k]
                                for k in [
                                    "space_id",
                                    "destination",
                                    "target_id",
                                    "format",
                                    "content_sha256",
                                    "title",
                                ]
                            }
                        ),
                        "result": json.loads(row["result"]) if row["result"] else None,
                    }
                )
            except APIError:
                pass
        return {"proposals": proposals, "exports": plans}

    def create_rule(self, data):
        if self.identity.grant:
            fail(403, "interactive_required", "自动规则需由用户明确配置")
        grant_id = text(data.get("grant_id"), "访问授权", 100)
        writer = valid_grant(self.db, self.api, grant_id)
        if writer.actor != self.identity.actor:
            fail(404, "not_found", "授权不属于当前用户")
        writer.require("knowledge:export")
        space = writer.space(data.get("space_id", "personal"))
        writer.can_export(space, data.get("destination"))
        fields = writer.fields(data.get("fields", writer.policy["fields"]))
        destination = data.get("destination")
        if destination not in ["obsidian", "feishu", "ima"]:
            fail(400, "invalid_input", "请选择真实目的地")
        payload = {
            "space_id": space,
            "fields": fields,
            "destination": destination,
            "target_id": text(data.get("target_id"), "目标标识", 500),
            "max_daily": integer(data.get("max_daily", 20), "每日上限", 1, 100),
            "allow_update": bool(data.get("allow_update", False)),
            "format": "full_record",
        }
        ident = uuid.uuid4().hex
        last = (
            0
            if data.get("include_existing") is True
            else self.db.execute(
                "SELECT COALESCE(MAX(seq),0) AS n FROM knowledge_events"
            ).fetchone()["n"]
        )
        self.db.execute(
            "INSERT INTO export_rules VALUES (?,?,?,?,?,?,?)",
            (
                ident,
                self.identity.actor,
                grant_id,
                kbase.encoded(payload),
                int(data.get("enabled") is True),
                kbase.stamp(),
                last,
            ),
        )
        self.identity.audit("export.rule", space=space)
        return {"id": ident, **payload, "enabled": data.get("enabled") is True}


def run_rules(db, api):
    """Create approved jobs from exact user rules; provider credentials stay on the local runner."""
    expired = db.execute(
        "SELECT id FROM export_plans WHERE status='running' AND lease_until<?",
        (kbase.stamp(),),
    ).fetchall()
    for row in expired:
        db.execute(
            "UPDATE export_plans SET status='unknown_result',updated=? WHERE id=?",
            (kbase.stamp(), row["id"]),
        )
    for rule in db.execute("SELECT * FROM export_rules WHERE enabled=1").fetchall():
        try:
            writer = valid_grant(db, api, rule["grant_id"])
        except APIError:
            db.execute("UPDATE export_rules SET enabled=0 WHERE id=?", (rule["id"],))
            continue
        data = json.loads(rule["data"])
        service = TransferService(db, api, writer)
        created = 0
        daily = db.execute(
            "SELECT COUNT(*) AS n FROM access_audit WHERE grant_id=? AND action='export.prepare' AND at>=?",
            (writer.id, kbase.stamp()[:10]),
        ).fetchone()["n"]
        for event in db.execute(
            "SELECT seq,parent_id FROM knowledge_events WHERE seq>? ORDER BY seq LIMIT 100",
            (rule["last_seq"],),
        ).fetchall():
            if daily + created >= data["max_daily"]:
                break
            try:
                doc = writer.document(event["parent_id"])
                if (doc.get("space_id") or "personal") == data["space_id"]:
                    rev = kbase.current_revision(db, doc["id"])
                    dedup = kbase.digest(
                        {"rule": rule["id"], "item": doc["id"], "revision": rev}
                    )
                    if not db.execute(
                        "SELECT 1 FROM rule_runs WHERE id=?", (dedup,)
                    ).fetchone():
                        service.prepare_export(
                            {
                                **data,
                                "title": doc.get("title") or "知识沉淀",
                                "extraction": {
                                    "selection": [
                                        {"item_id": doc["id"], "revision": rev}
                                    ],
                                    "fields": data["fields"],
                                    "max_characters": 100000,
                                },
                            },
                            auto=True,
                        )
                        db.execute(
                            "INSERT INTO rule_runs VALUES (?,?)", (dedup, kbase.stamp())
                        )
                        created += 1
            except APIError:
                pass
            db.execute(
                "UPDATE export_rules SET last_seq=? WHERE id=?",
                (event["seq"], rule["id"]),
            )
