"""Real OAuth and MCP transports, SDK and runner against an isolated HTTP service."""

import asyncio, base64, hashlib, json, os, socket, subprocess, sys, tempfile, time, unittest, urllib.parse, urllib.request, urllib.error
from pathlib import Path
from unittest.mock import patch
from test_open_api import Client as Browser, ROOT
from sediment import Client, ClientError
from sediment.client import NoRedirect
from sediment.runner import run_plan
from sediment.profiles import save_profiles


class ProtocolTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.temp.name)
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            cls.port = s.getsockname()[1]
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            cls.mcp_port = s.getsockname()[1]
        cls.url = f"http://127.0.0.1:{cls.port}"
        cls.resource = f"http://127.0.0.1:{cls.mcp_port}/mcp"
        cls.process = subprocess.Popen(
            [sys.executable, str(ROOT / "server/app.py")],
            env={
                **os.environ,
                "SEDIMENT_STORAGE": str(cls.folder / "server"),
                "SEDIMENT_PORT": str(cls.port),
                "SEDIMENT_MCP_PUBLIC_URL": cls.resource,
                "SEDIMENT_QUIET": "1",
            },
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        cls.owner = Browser(cls.url)
        for _ in range(80):
            try:
                if cls.owner.request("/api/health")[0] == 200:
                    break
            except Exception:
                time.sleep(0.05)
        cls.owner.good(
            "/api/register",
            {
                "email": "protocol@example.test",
                "password": "protocol-password",
                "display_name": "协议测试",
            },
        )

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(timeout=5)
        cls.temp.cleanup()

    def note(self, body="Protocol fixture content", **extra):
        import uuid

        return self.owner.good(
            "/api/items",
            {
                "id": uuid.uuid4().hex,
                "type": "note",
                "body": body,
                "title": "协议合成记录",
                "topic_ids": [],
                "atts": [],
                **extra,
            },
        )

    def grant(self, item, scopes=None, fields=None):
        return self.owner.good(
            "/api/v1/grants",
            {
                "name": "协议 Agent",
                "item_ids": [item["id"]],
                "fields": fields or ["original", "provenance"],
                "scopes": scopes
                or [
                    "knowledge:read",
                    "proposals:create",
                    "knowledge:export",
                    "exports:run",
                    "changes:read",
                ],
                "space_ids": ["personal"],
            },
        )

    def oauth(self, resource=None):
        client = self.owner.good(
            "/oauth/register",
            {
                "client_name": "Protocol MCP",
                "redirect_uris": ["http://127.0.0.1:48179/callback"],
            },
        )
        verifier = "a" * 64
        challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
            .decode()
            .rstrip("=")
        )
        params = {
            "client_id": client["client_id"],
            "redirect_uri": client["redirect_uris"][0],
            "response_type": "code",
            "code_challenge_method": "S256",
            "code_challenge": challenge,
            "resource": resource or self.resource,
            "scope": "knowledge:read proposals:create",
            "state": "fixture-state",
        }
        opener = urllib.request.build_opener(NoRedirect())
        try:
            opener.open(self.url + "/oauth/authorize?" + urllib.parse.urlencode(params))
            self.fail("expected redirect")
        except urllib.error.HTTPError as e:
            if e.code != 302:
                return e.code, json.loads(e.read())
            request_id = urllib.parse.parse_qs(
                urllib.parse.urlparse(e.headers["Location"]).query
            )["oauth_request"][0]
        return {
            "client": client,
            "verifier": verifier,
            "request_id": request_id,
            "params": params,
        }

    def test_oauth_pkce_single_use_audience_refresh_rotation_and_revocation(self):
        note = self.note()
        flow = self.oauth()
        info = self.owner.good("/api/v1/oauth/" + flow["request_id"] + "/context")
        self.assertEqual(info["resource"], self.resource)
        policy = {
            "name": "OAuth fixture",
            "space_ids": ["personal"],
            "item_ids": [note["id"]],
            "fields": ["original"],
            "scopes": ["knowledge:read", "proposals:create"],
        }
        consent = self.owner.good(
            "/api/v1/oauth/" + flow["request_id"] + "/consent",
            {"approve": True, "policy": policy},
        )
        q = urllib.parse.parse_qs(urllib.parse.urlparse(consent["redirect_url"]).query)
        self.assertEqual(q["state"], ["fixture-state"])
        data = {
            "grant_type": "authorization_code",
            "client_id": flow["client"]["client_id"],
            "redirect_uri": flow["params"]["redirect_uri"],
            "resource": self.resource,
            "code": q["code"][0],
            "code_verifier": flow["verifier"],
        }
        self.assertEqual(
            self.owner.request("/oauth/token", {**data, "code_verifier": "b" * 64})[0],
            400,
        )
        self.assertEqual(
            self.owner.request("/oauth/token", {**data, "resource": self.url})[0], 400
        )
        token = self.owner.good("/oauth/token", data)
        c = Client(self.url, token["access_token"])
        self.assertEqual(c.read(note["id"])["revision"], 1)
        self.assertEqual(self.owner.request("/oauth/token", data)[0], 400)
        refresh = {
            "grant_type": "refresh_token",
            "client_id": data["client_id"],
            "resource": self.resource,
            "refresh_token": token["refresh_token"],
        }
        rotated = self.owner.good("/oauth/token", refresh)
        self.assertNotEqual(token["access_token"], rotated["access_token"])
        self.assertEqual(self.owner.request("/oauth/token", refresh)[0], 400)
        cap = c.capabilities()
        self.owner.good("/api/v1/grants/" + cap["grant_id"] + "/revoke", {})
        with self.assertRaises(ClientError):
            Client(self.url, rotated["access_token"]).capabilities()
        import sqlite3

        db = sqlite3.connect(self.folder / "server/workspace.sqlite3")
        dump = "\n".join(db.iterdump())
        db.close()
        for secret in [
            token["access_token"],
            token["refresh_token"],
            q["code"][0],
            rotated["access_token"],
        ]:
            self.assertNotIn(secret, dump)
        self.assertEqual(self.oauth(self.url)[0], 400)

    def test_rotation_preserves_fixed_range_and_invalidates_old_token(self):
        note = self.note()
        g = self.grant(note)
        later = self.note()
        new = self.owner.good("/api/v1/grants/" + g["id"] + "/rotate", {})
        self.assertEqual(
            g["policy"]["captured_item_ids"], new["policy"]["captured_item_ids"]
        )
        with self.assertRaises(ClientError):
            Client(self.url, g["token"]).capabilities()
        with self.assertRaises(ClientError):
            Client(self.url, new["token"]).read(later["id"])

    def test_actual_stdio_mcp_initialize_tools_resource_and_acl(self):
        try:
            from mcp import ClientSession, StdioServerParameters
            from mcp.client.stdio import stdio_client
        except ImportError:
            self.skipTest("install .[test] for protocol transport test")
        note = self.note()
        g = self.grant(note)
        hidden = self.note("HIDDEN MCP FIXTURE")

        async def scenario():
            params = StdioServerParameters(
                command=sys.executable,
                args=["-m", "sediment.cli", "mcp"],
                cwd=ROOT,
                env={
                    **os.environ,
                    "SEDIMENT_URL": self.url,
                    "SEDIMENT_TOKEN": g["token"],
                },
            )
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    initialized = await session.initialize()
                    self.assertTrue(initialized.protocolVersion)
                    listed = await session.list_tools()
                    names = {t.name for t in listed.tools}
                    self.assertIn("knowledge_read", names)
                    self.assertIn("knowledge_propose", names)
                    result = await session.call_tool(
                        "knowledge_read", {"item_id": note["id"]}
                    )
                    self.assertFalse(result.isError)
                    self.assertIn("Protocol fixture", result.content[0].text)
                    denied = await session.call_tool(
                        "knowledge_read", {"item_id": hidden["id"]}
                    )
                    self.assertTrue(denied.isError)
                    self.assertNotIn("HIDDEN MCP FIXTURE", str(denied))
                    resource = await session.read_resource(
                        "sediment://knowledge/" + note["id"]
                    )
                    self.assertIn("Protocol fixture", resource.contents[0].text)

        asyncio.run(scenario())

    def test_actual_remote_mcp_oauth_metadata_transport_and_revocation(self):
        try:
            import httpx
            from mcp import ClientSession
            from mcp.client.streamable_http import streamable_http_client
        except ImportError:
            self.skipTest("install .[test] for protocol transport test")
        note = self.note()
        g = self.grant(note)
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "sediment.cli",
                "mcp",
                "--transport",
                "streamable-http",
                "--url",
                self.url,
                "--resource",
                self.resource,
                "--port",
                str(self.mcp_port),
            ],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            for _ in range(100):
                try:
                    with urllib.request.urlopen(
                        self.resource.replace(
                            "/mcp", "/.well-known/oauth-protected-resource/mcp"
                        )
                    ) as r:
                        metadata = json.loads(r.read())
                        break
                except Exception:
                    time.sleep(0.05)
            else:
                self.fail("MCP metadata unavailable")
            self.assertEqual(metadata["resource"], self.resource)
            self.assertIn(self.url + "/", metadata["authorization_servers"])

            async def scenario():
                async with httpx.AsyncClient(
                    headers={"Authorization": "Bearer " + g["token"]}, trust_env=False
                ) as http:
                    async with streamable_http_client(
                        self.resource, http_client=http
                    ) as (read, write, _):
                        async with ClientSession(read, write) as session:
                            await session.initialize()
                            result = await session.call_tool(
                                "knowledge_read", {"item_id": note["id"]}
                            )
                            self.assertFalse(result.isError)
                self.owner.good("/api/v1/grants/" + g["id"] + "/revoke", {})
                async with httpx.AsyncClient(trust_env=False) as http:
                    result = await http.post(
                        self.resource,
                        headers={"Authorization": "Bearer " + g["token"]},
                        json={
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "initialize",
                            "params": {},
                        },
                    )
                    self.assertEqual(result.status_code, 401)
                    self.assertIn(
                        "resource_metadata", result.headers.get("www-authenticate", "")
                    )

            asyncio.run(scenario())
        finally:
            process.terminate()
            process.wait(timeout=5)

    def test_real_local_runner_obsidian_receipt_attachment_conflict_and_pull(self):
        vault = self.folder / "vault"
        vault.mkdir(exist_ok=True)
        config = self.folder / "local-config"
        raw = b"fixture attachment bytes"
        request = urllib.request.Request(
            self.url + "/api/files",
            data=raw,
            headers={
                "Content-Type": "text/plain",
                "X-File-Name": "fixture.txt",
                "Origin": self.url,
            },
        )
        att = json.loads(self.owner.opener.open(request).read())
        note = self.note("Original runner fixture", atts=[att])
        g = self.grant(
            note,
            scopes=[
                "knowledge:read",
                "proposals:create",
                "knowledge:export",
                "exports:run",
                "attachments:read",
            ],
            fields=["original", "attachment_metadata"],
        )
        client = Client(self.url, g["token"])

        def plan(note, allow_update=False):
            pack = client.extract(
                [{"item_id": note["id"], "revision": note["revision"]}],
                fields=["original", "attachment_metadata"],
                purpose="portable_export",
            )
            draft = client.prepare_export(
                {
                    "space_id": "personal",
                    "snapshot_id": pack["snapshot_id"],
                    "destination": "obsidian",
                    "target_id": "test-vault",
                    "allow_update": allow_update,
                }
            )
            self.owner.good("/api/v1/export-plans/" + draft["id"] + "/approve", {})
            return draft["id"]

        with patch.dict(os.environ, {"SEDIMENT_CONFIG_DIR": str(config)}):
            save_profiles(
                {
                    "sources": {},
                    "destinations": {
                        "vault": {
                            "kind": "obsidian",
                            "target_id": "test-vault",
                            "vault": str(vault),
                            "folder": "沉淀",
                        }
                    },
                }
            )
            pid = plan(note)
            result = run_plan(client, pid, "vault")
            self.assertTrue(result["read_back_verified"])
            self.assertEqual(result["verification"], "runner_reported")
            path = vault / "沉淀" / result["destination_item_id"]
            self.assertIn("sediment_source:", path.read_text())
            self.assertIn(note["id"], path.read_text())
            self.assertEqual(
                (vault / "沉淀" / "attachments" / (att["id"] + ".txt")).read_bytes(),
                raw,
            )
            self.assertEqual(
                run_plan(client, pid, "vault")["status"], "already_completed"
            )
            path.write_text(path.read_text() + "\nExternal fixture edit\n")
            changed = self.owner.good(
                "/api/items", {**note, "body": "Changed runner fixture"}
            )
            pid2 = plan(changed, True)
            conflict = run_plan(client, pid2, "vault")
            self.assertEqual(conflict["status"], "failed")
            self.assertEqual(conflict["stage"], "plan")
            self.assertIn("External fixture edit", path.read_text())
            proposal = run_plan(client, pid, "vault", pull=True)
            self.assertEqual(proposal["status"], "awaiting_approval")
            self.assertNotIn(
                "External fixture edit",
                self.owner.good("/api/state")["items"][0]["body"],
            )
