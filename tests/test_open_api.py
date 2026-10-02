"""End-to-end scope, citation, adoption and export checks on synthetic data."""

import json, os, socket, subprocess, tempfile, time, unittest, urllib.request, urllib.error, http.cookiejar, uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class Client:
    def __init__(self, url, token=None):
        self.url, self.token = url, token
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )

    def request(self, path, data=None, headers=None):
        h = {
            "Content-Type": "application/json",
            "Origin": self.url,
            "X-Sediment-Interactive": "1",
        }
        if self.token:
            h["Authorization"] = "Bearer " + self.token
        h.update(headers or {})
        req = urllib.request.Request(
            self.url + path,
            data=json.dumps(data).encode() if data is not None else None,
            headers=h,
        )
        try:
            r = self.opener.open(req)
            return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def good(self, path, data=None, headers=None):
        status, value = self.request(path, data, headers)
        if status != 200:
            raise AssertionError((status, value))
        return value


class OpenKnowledgeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        cls.url = f"http://127.0.0.1:{port}"
        cls.process = subprocess.Popen(
            ["python", str(ROOT / "server/app.py")],
            env={
                **os.environ,
                "SEDIMENT_STORAGE": cls.temp.name,
                "SEDIMENT_PORT": str(port),
                "SEDIMENT_QUIET": "1",
            },
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        cls.owner = Client(cls.url)
        for _ in range(60):
            try:
                if cls.owner.request("/api/health")[0] == 200:
                    break
            except Exception:
                time.sleep(0.05)
        cls.owner.good(
            "/api/register",
            {
                "email": "api-owner@example.test",
                "password": "test-password",
                "display_name": "API所有者",
            },
        )
        cls.other = Client(cls.url)
        cls.other.good(
            "/api/register",
            {
                "email": "api-other@example.test",
                "password": "other-password",
                "display_name": "其他作者",
            },
        )

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(timeout=5)
        cls.temp.cleanup()

    def note(
        self,
        body="测试内容",
        kind="note",
        space=None,
        topics=None,
        client=None,
        **extra,
    ):
        return (client or self.owner).good(
            "/api/items",
            {
                "id": uuid.uuid4().hex,
                "type": kind,
                "title": "合成记录",
                "body": body,
                "space_id": space,
                "topic_ids": topics or [],
                "atts": [],
                "created_at": "2026-10-02T00:00:00+00:00",
                **extra,
            },
        )

    def grant(self, items=None, fields=None, scopes=None, **extra):
        return self.owner.good(
            "/api/v1/grants",
            {
                "name": "合成 Agent",
                "space_ids": ["personal"],
                "item_ids": [x["id"] for x in items or []],
                "fields": fields or ["original", "current_understanding", "provenance"],
                "scopes": scopes
                or [
                    "knowledge:read",
                    "proposals:create",
                    "knowledge:export",
                    "exports:run",
                    "changes:read",
                ],
                "dynamic_membership": False,
                **extra,
            },
        )

    def test_current_understanding_only_does_not_search_original(self):
        a = self.note("HIDDEN_ORIGINAL_SENTINEL")
        reply = self.owner.good(
            "/api/replies",
            {
                "id": uuid.uuid4().hex,
                "item_id": a["id"],
                "body": "ONLY_ADOPTED_SENTINEL",
                "atts": [],
                "is_progress": False,
            },
        )
        a = {**a, "revision": reply["item_revision"], "und": reply["id"]}
        a = self.owner.good("/api/items", a)
        grant = self.grant([a], ["current_understanding"])
        agent = Client(self.url, grant["token"])
        result = agent.good("/api/v1/items/" + a["id"])
        self.assertIn("ONLY_ADOPTED_SENTINEL", json.dumps(result))
        self.assertNotIn("HIDDEN_ORIGINAL_SENTINEL", json.dumps(result))
        matches = agent.good(
            "/api/v1/search",
            {"space_id": "personal", "query": "HIDDEN_ORIGINAL_SENTINEL"},
        )["items"]
        self.assertEqual(matches, [])
        self.assertEqual(
            agent.request("/api/v1/items/" + a["id"] + "?fields=original")[0], 403
        )
        self.assertEqual(agent.request("/api/v1/items/" + a["id"] + "/history")[0], 403)
        self.assertEqual(agent.request("/api/v1/grants")[0], 403)

    def test_segments_preserve_identity_and_revisions_are_immutable(self):
        a = self.note("第一段原文\n\n第二段原文")
        first = self.owner.good("/api/v1/items/" + a["id"])["fragments"]
        a = self.owner.good("/api/items", {**a, "body": "第一段原文\n\n第二段修订"})
        now = self.owner.good("/api/v1/items/" + a["id"])["fragments"]
        self.assertEqual(first[0]["part_id"], now[0]["part_id"])
        self.assertEqual(first[1]["part_id"], now[1]["part_id"])
        old = self.owner.good("/api/v1/items/" + a["id"] + "?revision=1")["fragments"]
        self.assertEqual(old[1]["text"], "第二段原文")
        self.assertEqual(
            self.owner.request(
                "/api/items", {**a, "revision": 1, "body": "旧窗口覆盖"}
            )[0],
            409,
        )

    def test_static_range_dynamic_range_and_revocation(self):
        topic = self.note(kind="topic")
        first = self.note(topics=[topic["id"]])
        grant = self.grant(topic_ids=[topic["id"]])
        dynamic = self.grant(topic_ids=[topic["id"]], dynamic_membership=True)
        later = self.note(topics=[topic["id"]])
        fixed = Client(self.url, grant["token"])
        changing = Client(self.url, dynamic["token"])
        self.assertEqual(fixed.request("/api/v1/items/" + later["id"])[0], 404)
        self.assertEqual(changing.request("/api/v1/items/" + later["id"])[0], 200)
        private = self.note(client=self.other)
        self.assertEqual(changing.request("/api/v1/items/" + private["id"])[0], 404)
        self.owner.good("/api/v1/grants/" + dynamic["id"] + "/revoke", {})
        self.assertEqual(changing.request("/api/v1/items/" + first["id"])[0], 401)
        import sqlite3

        db = sqlite3.connect(Path(self.temp.name) / "workspace.sqlite3")
        self.assertNotIn(grant["token"], "\n".join(db.iterdump()))
        db.close()

    def test_agent_cannot_approve_and_adoption_is_idempotent(self):
        a = self.note()
        grant = self.grant([a])
        agent = Client(self.url, grant["token"])
        data = {
            "space_id": "personal",
            "action": "append_reply",
            "target_item_id": a["id"],
            "base_revision": a["revision"],
            "content": "Agent待采纳内容",
            "source_refs": [{"item_id": a["id"], "revision": a["revision"]}],
        }
        proposal = agent.good(
            "/api/v1/proposals", data, {"Idempotency-Key": "proposal-1"}
        )
        again = agent.good("/api/v1/proposals", data, {"Idempotency-Key": "proposal-1"})
        self.assertEqual(proposal["id"], again["id"])
        self.assertEqual(
            agent.request(
                "/api/v1/proposals",
                {**data, "content": "不同内容"},
                {"Idempotency-Key": "proposal-1"},
            )[0],
            409,
        )
        self.assertEqual(
            agent.request("/api/v1/proposals/" + proposal["id"] + "/adopt", {})[0], 403
        )
        adopted = self.owner.good(
            "/api/v1/proposals/" + proposal["id"] + "/adopt",
            {"content": "人工编辑后的收录"},
        )
        again = self.owner.good("/api/v1/proposals/" + proposal["id"] + "/adopt", {})
        self.assertEqual(
            {k: v for k, v in again.items() if k != "request_id"},
            {k: v for k, v in adopted.items() if k != "request_id"},
        )
        self.assertEqual(
            len(
                [
                    r
                    for r in self.owner.good("/api/state")["replies"]
                    if r["item_id"] == a["id"]
                ]
            ),
            1,
        )

    def test_approved_export_claim_receipt_and_no_fake_verification(self):
        a = self.note("带引用的原文")
        grant = self.grant([a])
        agent = Client(self.url, grant["token"])
        package = agent.good(
            "/api/v1/extractions",
            {
                "space_id": "personal",
                "selection": [{"item_id": a["id"], "revision": a["revision"]}],
                "fields": ["original"],
                "purpose": "portable_export",
            },
        )
        plan = agent.good(
            "/api/v1/export-plans",
            {
                "space_id": "personal",
                "snapshot_id": package["snapshot_id"],
                "destination": "obsidian",
                "target_id": "my-vault",
            },
        )
        self.assertEqual(
            agent.request("/api/v1/export-plans/" + plan["id"] + "/package")[0], 409
        )
        self.assertEqual(
            agent.request("/api/v1/export-plans/" + plan["id"] + "/approve", {})[0], 403
        )
        self.owner.good("/api/v1/export-plans/" + plan["id"] + "/approve", {})
        claim = agent.good(
            "/api/v1/export-plans/" + plan["id"] + "/claim",
            {"executor_id": "test-local"},
        )
        self.assertEqual(
            agent.request(
                "/api/v1/export-plans/" + plan["id"] + "/claim",
                {"executor_id": "again"},
            )[0],
            409,
        )
        receipt = agent.good(
            "/api/v1/export-plans/" + plan["id"] + "/receipts",
            {
                "lease": claim["lease"],
                "status": "completed",
                "verification": "independently_verified",
                "read_back_verified": True,
                "destination_url": "https://example.test/document?token=temporary",
            },
        )
        self.assertEqual(receipt["verification"], "runner_reported")
        self.assertNotIn("temporary", json.dumps(receipt))

    def test_cursor_bound_to_identity_and_scope_and_hidden_source_filtered(self):
        a = self.note("原文可见")
        hidden = self.note("SOURCE_SNAPSHOT_HIDDEN")
        a = self.owner.good(
            "/api/items",
            {
                **a,
                "ai": {
                    "sources": [
                        {
                            "itemId": hidden["id"],
                            "text": "SOURCE_SNAPSHOT_HIDDEN",
                            "title": "隐藏来源",
                        }
                    ]
                },
            },
        )
        grant = self.grant([a])
        other = self.grant([a])
        agent = Client(self.url, grant["token"])
        data = agent.good("/api/v1/items/" + a["id"])
        self.assertNotIn("SOURCE_SNAPSHOT_HIDDEN", json.dumps(data))
        self.assertNotIn(hidden["id"], json.dumps(data))
        cursor = agent.good("/api/v1/changes")["cursor"]
        self.assertEqual(
            Client(self.url, other["token"]).request(
                "/api/v1/changes?cursor=" + cursor
            )[0],
            409,
        )
        self.assertNotIn("watermark", agent.good("/api/v1/changes?cursor=" + cursor))

    def test_team_external_permission_and_read_only_role(self):
        space = self.owner.good(
            "/api/spaces", {"name": "开放权限测试", "description": ""}
        )["id"]
        a = self.note(space=space)
        self.assertEqual(
            self.owner.request(
                "/api/v1/grants", {"name": "团队Agent", "space_ids": [space]}
            )[0],
            403,
        )
        self.owner.good(
            "/api/v1/policies/" + space,
            {
                "allow_read": True,
                "allow_export": True,
                "allowed_destinations": ["feishu"],
            },
        )
        grant = self.grant([a], space_ids=[space])
        agent = Client(self.url, grant["token"])
        self.assertEqual(agent.request("/api/v1/items/" + a["id"])[0], 200)
        self.assertEqual(
            agent.request(
                "/api/v1/export-plans",
                {
                    "space_id": space,
                    "destination": "ima",
                    "target_id": "kb",
                    "extraction": {
                        "selection": [{"item_id": a["id"], "revision": a["revision"]}],
                        "fields": ["original"],
                    },
                },
            )[0],
            403,
        )
        self.owner.good(
            "/api/v1/policies/" + space,
            {"allow_read": False, "allow_export": False, "allowed_destinations": []},
        )
        self.assertEqual(agent.request("/api/v1/items/" + a["id"])[0], 404)

    def test_validation_needs_evidence_not_legacy_attitude(self):
        a = self.note("合成经验", kind="experience", exp_st="我尝试过")
        result = self.owner.good("/api/v1/items/" + a["id"] + "?fields=validation")
        self.assertEqual(result["fragments"][0]["validation"]["status"], "unverified")
        self.assertEqual(
            self.owner.request(
                "/api/v1/items/" + a["id"] + "/validation",
                {"status": "supported", "revision": a["revision"]},
            )[0],
            400,
        )
        result = self.owner.good(
            "/api/v1/items/" + a["id"] + "/validation",
            {
                "status": "supported",
                "revision": a["revision"],
                "observation": "合成试验三次观察",
                "conditions": "仅限测试",
            },
        )
        self.assertEqual(result["validation"]["status"], "supported")


if __name__ == "__main__":
    unittest.main()
