"""Additional isolation, lifecycle and portability invariants on synthetic fixtures."""

import json, sqlite3, unittest, uuid, urllib.request, urllib.error
import test_protocols as helpers
from test_open_api import Client as Browser
from sediment import Client, ClientError


class ExtendedSecurityTest(unittest.TestCase):
    setUpClass = classmethod(helpers.ProtocolTest.setUpClass.__func__)
    tearDownClass = classmethod(helpers.ProtocolTest.tearDownClass.__func__)
    note = helpers.ProtocolTest.note
    grant = helpers.ProtocolTest.grant

    def test_default_grant_is_read_only(self):
        note = self.note()
        grant = self.owner.good(
            "/api/v1/grants", {"name": "默认只读", "item_ids": [note["id"]]}
        )
        agent = Client(self.url, grant["token"])
        self.assertEqual(agent.capabilities()["scopes"], ["knowledge:read"])
        with self.assertRaises(ClientError) as error:
            agent.propose(
                {
                    "space_id": "personal",
                    "action": "append_reply",
                    "target_item_id": note["id"],
                    "content": "未经授权的合成补充",
                }
            )
        self.assertEqual(error.exception.status, 403)

    def test_production_requires_offline_owner_and_has_no_anonymous_fallback(self):
        import os, socket, subprocess, sys, tempfile, time
        from pathlib import Path

        with tempfile.TemporaryDirectory() as folder:
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            env = {
                **os.environ,
                "SEDIMENT_STORAGE": str(Path(folder) / "server"),
                "SEDIMENT_ENV": "production",
                "SEDIMENT_PUBLIC_URL": "https://production.example.test",
                "SEDIMENT_PORT": str(port),
                "SEDIMENT_QUIET": "1",
            }
            app = [sys.executable, str(helpers.ROOT / "server/app.py")]
            denied = subprocess.run(app, env=env, capture_output=True, timeout=5)
            self.assertNotEqual(denied.returncode, 0)
            self.assertIn("离线配置所有者", denied.stderr.decode())
            password = Path(folder) / "password"
            password.write_text("production-fixture-password")
            bootstrap = subprocess.run(
                [
                    sys.executable,
                    str(helpers.ROOT / "scripts/provision-owner.py"),
                    "--email",
                    "production-owner@example.test",
                    "--password-file",
                    str(password),
                ],
                env=env,
                capture_output=True,
                timeout=5,
            )
            self.assertEqual(bootstrap.returncode, 0, bootstrap.stderr.decode())
            self.assertNotIn(password.read_bytes(), bootstrap.stdout + bootstrap.stderr)
            server = subprocess.Popen(
                app, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            url = f"http://127.0.0.1:{port}"
            try:
                for _ in range(80):
                    try:
                        urllib.request.urlopen(url + "/api/health")
                        break
                    except (urllib.error.URLError, OSError):
                        time.sleep(0.05)
                for endpoint in ["/api/state", "/api/v1/capabilities"]:
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        urllib.request.urlopen(url + endpoint)
                    self.assertEqual(error.exception.code, 401)
                request = urllib.request.Request(
                    url + "/api/login",
                    data=json.dumps(
                        {
                            "email": "production-owner@example.test",
                            "password": password.read_text(),
                        }
                    ).encode(),
                    headers={
                        "Content-Type": "application/json",
                        "Origin": env["SEDIMENT_PUBLIC_URL"],
                    },
                )
                with urllib.request.urlopen(request) as response:
                    self.assertIn("; Secure", response.headers["Set-Cookie"])
                    self.assertIn("HttpOnly", response.headers["Set-Cookie"])
            finally:
                server.terminate()
                server.wait(timeout=5)

    def other(self):
        other = Browser(self.url)
        other.good(
            "/api/register",
            {
                "email": uuid.uuid4().hex + "@example.test",
                "password": "other-test-password",
                "display_name": "其他合成作者",
            },
        )
        return other

    def test_legacy_routes_never_accept_agent_as_owner(self):
        g = self.grant(self.note())
        for path in ["/api/state", "/api/export.json"]:
            request = urllib.request.Request(
                self.url + path, headers={"Authorization": "Bearer " + g["token"]}
            )
            with self.assertRaises(urllib.error.HTTPError) as e:
                urllib.request.urlopen(request)
            self.assertEqual(e.exception.code, 401)
        self.assertEqual(
            self.owner.request(
                "/api/v1/grants", {}, {"Authorization": "Bearer " + g["token"]}
            )[0],
            403,
        )

    def test_attachment_id_cannot_be_forged_to_expose_another_user_file(self):
        other = self.other()
        raw = b"PRIVATE_ATTACHMENT_FIXTURE"
        att = json.loads(
            other.opener.open(
                urllib.request.Request(
                    self.url + "/api/files",
                    data=raw,
                    headers={
                        "Origin": self.url,
                        "Content-Type": "text/plain",
                        "X-File-Name": "private.txt",
                    },
                )
            ).read()
        )
        forged = {
            "id": uuid.uuid4().hex,
            "type": "note",
            "body": "forged attachment fixture",
            "atts": [att],
            "topic_ids": [],
        }
        self.assertEqual(self.owner.request("/api/items", forged)[0], 400)
        with self.assertRaises(urllib.error.HTTPError):
            self.owner.opener.open(self.url + "/api/files/" + att["id"])

    def test_changes_and_cursors_do_not_reveal_unrelated_events(self):
        a = self.note()
        b = self.note()
        g = self.owner.good(
            "/api/v1/grants",
            {
                "name": "限定变化",
                "space_ids": ["personal"],
                "item_ids": [a["id"], b["id"]],
                "fields": ["original"],
                "scopes": ["knowledge:read", "changes:read"],
            },
        )
        agent = Client(self.url, g["token"])
        first = agent.search("", limit=1)
        self.assertTrue(first["next_cursor"])
        c = agent.changes(limit=1)
        while c["has_more"]:
            c = agent.changes(c["cursor"], 1)
        other = self.other()
        other.good(
            "/api/items",
            {
                "id": uuid.uuid4().hex,
                "type": "note",
                "title": "HIDDEN_EVENT_TITLE",
                "body": "hidden fixture event",
                "atts": [],
                "topic_ids": [],
            },
        )
        next_page = agent.search("", limit=1, cursor=first["next_cursor"])
        self.assertEqual(len(next_page["items"]), 1)
        changes = agent.changes(c["cursor"], 1)
        self.assertEqual(changes["changes"], [])
        self.assertFalse(changes["has_more"])
        self.assertNotIn("HIDDEN_EVENT_TITLE", json.dumps(changes))

    def test_history_extract_and_exact_citation_subset_keep_old_revision(self):
        a = self.note("OLD_REVISION_FIXTURE\n\nSecond original block")
        a = self.owner.good(
            "/api/items", {**a, "body": "NEW_REVISION_FIXTURE\n\nSecond original block"}
        )
        g = self.owner.good(
            "/api/v1/grants",
            {
                "name": "历史范围",
                "space_ids": ["personal"],
                "item_ids": [a["id"]],
                "fields": ["original", "history"],
                "scopes": [
                    "knowledge:read",
                    "history:read",
                    "knowledge:export",
                    "exports:run",
                ],
            },
        )
        agent = Client(self.url, g["token"])
        p = agent.extract(
            [{"item_id": a["id"]}],
            fields=["original", "history"],
            purpose="portable_export",
        )
        old = next(f for f in p["fragments"] if "OLD_REVISION_FIXTURE" in f["text"])
        self.assertEqual(old["revision"], 1)
        subset = agent.request(
            "/api/v1/extractions",
            {
                "space_id": "personal",
                "snapshot_id": p["snapshot_id"],
                "citation_ids": [old["citation_id"]],
                "purpose": "portable_export",
            },
        )
        self.assertEqual(len(subset["fragments"]), 1)
        self.assertNotIn("NEW_REVISION_FIXTURE", subset["markdown"])
        plan = agent.prepare_export(
            {
                "snapshot_id": subset["snapshot_id"],
                "destination": "obsidian",
                "target_id": "fixture-history",
            }
        )
        self.owner.good("/api/v1/export-plans/" + plan["id"] + "/approve", {})
        approved = agent.request("/api/v1/export-plans/" + plan["id"] + "/package")
        self.assertIn("OLD_REVISION_FIXTURE", approved["content"])
        self.assertEqual(
            p["package_sha256"],
            agent.extract(
                [{"item_id": a["id"]}],
                fields=["original", "history"],
                purpose="portable_export",
            )["package_sha256"],
        )

    def test_proposal_list_is_bound_to_the_creating_grant(self):
        a = self.note()
        g = self.grant(a)
        another = self.grant(a)
        agent = Client(self.url, g["token"])
        p = agent.propose(
            {
                "space_id": "personal",
                "action": "append_reply",
                "target_item_id": a["id"],
                "content": "PRIVATE_TO_GRANT_FIXTURE",
            }
        )
        outsiders = Client(self.url, another["token"]).request("/api/v1/proposals")
        self.assertNotIn(p["id"], json.dumps(outsiders))
        self.assertNotIn("PRIVATE_TO_GRANT_FIXTURE", json.dumps(outsiders))

    def test_direct_write_scope_works_without_proposal_scope_and_is_rate_limited(self):
        a = self.note()
        g = self.owner.good(
            "/api/v1/grants",
            {
                "name": "限额写入",
                "space_ids": ["personal"],
                "item_ids": [a["id"]],
                "fields": ["original"],
                "scopes": ["knowledge:read", "knowledge:write"],
                "allowed_write_actions": ["append_reply"],
                "max_new_items_per_day": 1,
            },
        )
        agent = Client(self.url, g["token"])
        data = {
            "space_id": "personal",
            "action": "append_reply",
            "target_item_id": a["id"],
            "base_revision": a["revision"],
            "content": "直接补充的合成内容",
        }
        first = agent.request("/api/v1/write", data, "fixed-write")
        again = agent.request("/api/v1/write", data, "fixed-write")
        self.assertEqual(first["reply_id"], again["reply_id"])
        with self.assertRaises(ClientError) as e:
            agent.request("/api/v1/write", {**data, "content": "另一条补充"})
        self.assertEqual(e.exception.status, 429)

    def test_expired_lease_becomes_unknown_and_cannot_be_reclaimed(self):
        a = self.note()
        g = self.grant(a)
        agent = Client(self.url, g["token"])
        p = agent.extract(
            [{"item_id": a["id"]}], fields=["original"], purpose="portable_export"
        )
        plan = agent.prepare_export(
            {
                "snapshot_id": p["snapshot_id"],
                "destination": "obsidian",
                "target_id": "fixture-lease",
            }
        )
        self.owner.good("/api/v1/export-plans/" + plan["id"] + "/approve", {})
        lease = agent.request(
            "/api/v1/export-plans/" + plan["id"] + "/claim",
            {"executor_id": "fixture-executor"},
        )
        db = sqlite3.connect(self.folder / "server/workspace.sqlite3")
        db.execute(
            "UPDATE export_plans SET lease_until='2000-01-01T00:00:00+00:00' WHERE id=?",
            (plan["id"],),
        )
        db.commit()
        db.close()
        agent.request("/api/v1/jobs")
        self.assertEqual(agent.operation(plan["id"])["status"], "unknown_result")
        with self.assertRaises(ClientError):
            agent.request(
                "/api/v1/export-plans/" + plan["id"] + "/claim",
                {"executor_id": "another"},
            )
        receipt = agent.request(
            "/api/v1/export-plans/" + plan["id"] + "/receipts",
            {
                "lease": lease["lease"],
                "status": "completed",
                "destination_item_id": "fixture-existing",
                "read_back_verified": True,
            },
        )
        self.assertEqual(receipt["verification"], "runner_reported")

    def test_rule_only_creates_exact_preauthorized_jobs_and_deduplicates(self):
        a = self.note()
        g = self.grant(a)
        agent = Client(self.url, g["token"])
        rule = self.owner.good(
            "/api/v1/rules",
            {
                "grant_id": g["id"],
                "space_id": "personal",
                "fields": ["original"],
                "destination": "obsidian",
                "target_id": "fixture-rule",
                "enabled": True,
                "include_existing": True,
                "max_daily": 3,
            },
        )
        first = agent.request("/api/v1/jobs")["jobs"]
        jobs = [j for j in first if j["target_id"] == "fixture-rule"]
        self.assertEqual(len(jobs), 1)
        again = [
            j
            for j in agent.request("/api/v1/jobs")["jobs"]
            if j["target_id"] == "fixture-rule"
        ]
        self.assertEqual([j["id"] for j in jobs], [j["id"] for j in again])
        self.owner.good("/api/v1/grants/" + g["id"] + "/revoke", {})
        db = sqlite3.connect(self.folder / "server/workspace.sqlite3")
        db.execute("UPDATE export_rules SET enabled=0 WHERE id=?", (rule["id"],))
        db.commit()
        db.close()

    def test_service_account_team_only_and_manager_review_then_disable(self):
        space = self.owner.good("/api/spaces", {"name": "合成服务团队"})["id"]
        self.owner.good(
            "/api/v1/policies/" + space,
            {
                "allow_read": True,
                "allow_export": True,
                "allowed_destinations": ["obsidian"],
            },
        )
        team_note = self.note("Service team fixture", space_id=space)
        private = self.note("PRIVATE_PERSONAL_FIXTURE")
        service = self.owner.good(
            "/api/v1/service-accounts",
            {
                "name": "合成服务账号",
                "space_id": space,
                "role": "editor",
                "policy": {
                    "name": "服务授权",
                    "space_ids": [space],
                    "item_ids": [team_note["id"]],
                    "fields": ["original"],
                    "scopes": ["knowledge:read", "proposals:create"],
                },
            },
        )
        agent = Client(self.url, service["token"])
        self.assertEqual(agent.capabilities()["spaces"], [space])
        with self.assertRaises(ClientError):
            agent.read(private["id"])
        proposed = agent.propose(
            {
                "space_id": space,
                "action": "append_reply",
                "target_item_id": team_note["id"],
                "content": "服务账号补充",
            }
        )
        adopted = self.owner.good("/api/v1/proposals/" + proposed["id"] + "/adopt", {})
        self.assertIn("reply_id", adopted)
        self.owner.good(
            "/api/v1/service-accounts/" + service["account_id"] + "/disable", {}
        )
        with self.assertRaises(ClientError):
            agent.capabilities()

    def test_openapi_schemas_validate_actual_packages_and_errors(self):
        try:
            import jsonschema
        except ImportError:
            self.skipTest("jsonschema unavailable")
        a = self.note()
        g = self.grant(a)
        agent = Client(self.url, g["token"])
        doc = agent.request("/api/v1/openapi")
        self.assertEqual(doc["openapi"], "3.1.0")
        self.assertNotIn("request_id", doc)
        schemas = doc["components"]["schemas"]
        p = agent.extract([{"item_id": a["id"]}], fields=["original"])
        jsonschema.Draft202012Validator(
            {
                "$ref": "#/components/schemas/KnowledgePackage",
                "components": doc["components"],
            }
        ).validate(p)
        for schema in schemas.values():
            jsonschema.Draft202012Validator.check_schema(schema)
        status, error = self.owner.request("/api/v1/items/unavailable-fixture")
        self.assertEqual(status, 404)
        jsonschema.Draft202012Validator(
            {"$ref": "#/components/schemas/Error", "components": doc["components"]}
        ).validate(error)
        self.assertEqual(error["schema_version"], "sediment.api.v1")
