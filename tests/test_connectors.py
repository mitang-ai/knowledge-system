"""Synthetic provider servers verify actual request/response contracts, not live accounts."""

import contextlib, json, os, socket, threading, time, unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from sediment.connectors.base import Http, DestinationError
from sediment.connectors.feishu import Feishu
from sediment.connectors.ima import Ima
from sediment.connectors.obsidian import Obsidian
from sediment.connectors import validate
from pathlib import Path
import tempfile


class Provider(BaseHTTPRequestHandler):
    records = []
    documents = {}
    files = {}
    counter = 0
    fail_add = False

    def log_message(self, *args):
        pass

    def reply(self, value, mime="application/json"):
        body = json.dumps(value).encode() if mime == "application/json" else value
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def do_PUT(self):
        data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        type(self).files[self.path] = data
        type(self).records.append(
            (
                self.command,
                self.path,
                data,
                {k.lower(): v for k, v in self.headers.items()},
            )
        )
        self.reply(b"", "application/octet-stream")

    def dispatch(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        data = json.loads(raw) if raw else None
        cls = type(self)
        cls.records.append(
            (
                self.command,
                self.path,
                data,
                {k.lower(): v for k, v in self.headers.items()},
            )
        )
        path = self.path
        result = {}
        if path.endswith("/tenant_access_token/internal"):
            return self.reply(
                {"code": 0, "tenant_access_token": "fixture-access-token"}
            )
        if path == "/open-apis/docx/v1/documents":
            cls.counter += 1
            ident = "fixture-doc-" + str(cls.counter)
            cls.documents[ident] = ""
            result = {"document": {"document_id": ident}}
        elif path.startswith("/open-apis/wiki/v2/spaces/") and path.endswith("/nodes"):
            cls.counter += 1
            ident = "fixture-wiki-doc-" + str(cls.counter)
            cls.documents[ident] = ""
            result = {"node": {"node_token": "fixture-node", "obj_token": ident}}
        elif "/children" in path:
            ident = path.split("/")[5]
            cls.documents[ident] = "\n".join(
                b["text"]["elements"][0]["text_run"]["content"]
                for b in data["children"]
            )
        elif path.endswith("/raw_content"):
            result = {"content": cls.documents[path.split("/")[5]]}
        elif path.endswith("/import_doc"):
            cls.counter += 1
            ident = "fixture-note-" + str(cls.counter)
            cls.documents[ident] = data["content"]
            result = {"note_id": ident}
        elif path.endswith("/get_doc_content"):
            result = {"content": cls.documents[data["note_id"]]}
        elif path.endswith("/check_repeated_names"):
            result = {
                "results": [{"name": data["params"][0]["name"], "is_repeated": False}]
            }
        elif path.endswith("/create_media"):
            cls.counter += 1
            ident = "fixture-media-" + str(cls.counter)
            result = {
                "media_id": ident,
                "cos_credential": {
                    "token": "fixture-temp-token",
                    "secret_id": "fixture-temp-id",
                    "secret_key": "fixture-temp-secret",
                    "start_time": int(time.time()) - 1,
                    "expired_time": int(time.time()) + 300,
                    "bucket_name": "fixture-12345",
                    "region": "ap-test",
                    "cos_key": ident + ".md",
                },
            }
        elif path.endswith("/add_knowledge"):
            if cls.fail_add:
                return self.reply({"code": 99, "msg": "fixture rejection", "data": {}})
            result = {"media_id": data.get("media_id", "fixture-linked-note")}
        elif path.endswith("/get_media_info"):
            result = {
                "media_type": 7,
                "url_info": {
                    "url": "https://res-skb.ima.qq.com/" + data["media_id"] + ".md",
                    "headers": {},
                },
            }
        elif path.endswith(".md"):
            return self.reply(cls.files[path], "text/markdown")
        elif path.endswith("/get_knowledge_base"):
            result = {"infos": {"fixture-kb": {"id": "fixture-kb"}}}
        elif path.endswith("/list_notebook"):
            result = {"note_folder_infos": [], "is_end": True}
        elif path.endswith("/append_doc"):
            cls.documents[data["note_id"]] += "\n" + data["content"]
            result = {"note_id": data["note_id"]}
        elif path.startswith("/open-apis/drive/v1/files"):
            result = {"files": []}
        elif "/wiki/v2/spaces/" in path:
            result = {"space": {"space_id": "fixture-space"}}
        self.reply({"code": 0, "data": result})


class ConnectorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        cls.url = "http://127.0.0.1:" + str(cls.server.server_port)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        Provider.records = []
        Provider.fail_add = False

    def package(self, kind):
        import hashlib

        content = "# Fixture title\n\nOnly synthetic content.\n[S1] fixture-source @ 修订 1 / fixture-part"
        return {
            "plan_id": "fixture-plan",
            "space_id": "personal",
            "destination": kind,
            "target_id": "fixture-target",
            "title": "合成沉淀稿",
            "content": content,
            "content_sha256": hashlib.sha256(
                json.dumps(
                    content, ensure_ascii=False, sort_keys=True, separators=(",", ":")
                ).encode()
            ).hexdigest(),
            "allow_update": False,
            "package": {
                "snapshot_id": "fixture-snapshot",
                "source_refs": [{"item_id": "fixture-source", "revision": 1}],
                "fragments": [],
                "fields": ["original"],
            },
        }

    @contextlib.contextmanager
    def local_provider(self):
        local = self.url

        class FixtureHttp(Http):
            def __init__(self, origin, headers=None):
                super().__init__(local, headers)

        with (
            patch("sediment.connectors.feishu.Http", FixtureHttp),
            patch("sediment.connectors.ima.Http", FixtureHttp),
            patch.dict(
                os.environ,
                {
                    "FEISHU_FIXTURE_SECRET": "fixture-secret",
                    "IMA_FIXTURE_KEY": "fixture-key",
                },
            ),
        ):
            yield

    def test_feishu_document_and_wiki_block_writes_read_back(self):
        with self.local_provider():
            for wiki in [False, True]:
                profile = {
                    "kind": "feishu",
                    "target_id": "fixture-target",
                    "app_id": "fixture-app",
                    "app_secret": "env:FEISHU_FIXTURE_SECRET",
                    **(
                        {"wiki_space": "fixture-space", "parent_node": "fixture-parent"}
                        if wiki
                        else {"folder_token": "fixture-folder"}
                    ),
                }
                adapter = Feishu(profile)
                self.assertTrue(adapter.probe()["ok"])
                package = self.package("feishu")
                stages = []
                result = adapter.apply(
                    package, None, lambda stage, data: stages.append(stage)
                )
                verified = adapter.verify(package, result)
                self.assertTrue(verified["read_back_verified"])
                self.assertIn("before_blocks", stages)
                if wiki:
                    self.assertEqual(result["node_id"], "fixture-node")
            writes = [r for r in Provider.records if r[1].endswith("/children")]
            self.assertEqual(len(writes), 2)
            self.assertEqual(
                writes[0][2]["children"][0]["text"]["elements"][0]["text_run"][
                    "content"
                ],
                "# Fixture title",
            )
            self.assertTrue(
                all(
                    r[3].get("authorization") == "Bearer fixture-access-token"
                    for r in Provider.records
                    if "/docx/" in r[1]
                )
            )

    def test_ima_note_and_knowledge_base_link(self):
        with self.local_provider():
            for mode in ["note", "kb_note"]:
                adapter = Ima(
                    {
                        "kind": "ima",
                        "target_id": "fixture-target",
                        "client_id": "fixture-client",
                        "api_key": "env:IMA_FIXTURE_KEY",
                        "mode": mode,
                        "knowledge_base_id": "fixture-kb",
                    }
                )
                self.assertTrue(adapter.probe()["ok"])
                package = self.package("ima")
                result = adapter.apply(package, None, lambda *args: None)
                self.assertTrue(adapter.verify(package, result)["read_back_verified"])
            link = [r for r in Provider.records if r[1].endswith("/add_knowledge")][0][
                2
            ]
            self.assertEqual(link["media_type"], 11)
            self.assertIn("content_id", link["note_info"])
            self.assertTrue(
                all(
                    r[3]["ima-openapi-apikey"] == "fixture-key"
                    for r in Provider.records
                    if "/openapi/" in r[1]
                )
            )

    def test_ima_cos_file_upload_add_and_readback(self):
        with self.local_provider():
            adapter = Ima(
                {
                    "kind": "ima",
                    "target_id": "fixture-target",
                    "client_id": "fixture-client",
                    "api_key": "env:IMA_FIXTURE_KEY",
                    "mode": "kb_file",
                    "knowledge_base_id": "fixture-kb",
                }
            )
            package = self.package("ima")
            stages = []
            result = adapter.apply(
                package, None, lambda stage, data: stages.append(stage)
            )
            self.assertTrue(adapter.verify(package, result)["read_back_verified"])
            self.assertIn("uploaded", stages)
            put = [r for r in Provider.records if r[0] == "PUT"][0]
            self.assertTrue(put[2].startswith(package["content"].encode()))
            self.assertTrue(
                put[3]["authorization"].startswith("q-sign-algorithm=sha1&")
            )
            self.assertNotIn("ima-openapi-apikey", put[3])
            self.assertEqual(put[3]["x-cos-security-token"], "fixture-temp-token")
            add = [r for r in Provider.records if r[1].endswith("/add_knowledge")][0][2]
            self.assertEqual(add["file_info"]["file_size"], len(put[2]))
            self.assertEqual(add["media_type"], 7)

    def test_provider_failure_retains_created_stage_and_no_retry(self):
        with self.local_provider():
            Provider.fail_add = True
            adapter = Ima(
                {
                    "kind": "ima",
                    "target_id": "fixture-target",
                    "client_id": "fixture-client",
                    "api_key": "env:IMA_FIXTURE_KEY",
                    "mode": "kb_note",
                    "knowledge_base_id": "fixture-kb",
                }
            )
            stages = []
            with self.assertRaises(DestinationError):
                adapter.apply(
                    self.package("ima"),
                    None,
                    lambda stage, data: stages.append((stage, data)),
                )
            self.assertTrue(
                any(
                    stage == "created" and data.get("note_id") for stage, data in stages
                )
            )
            self.assertEqual(
                len([r for r in Provider.records if r[1].endswith("/import_doc")]), 1
            )

    def test_obsidian_symlink_and_traversal_never_leave_vault(self):
        with tempfile.TemporaryDirectory() as folder:
            vault = Path(folder) / "vault"
            outside = Path(folder) / "outside"
            vault.mkdir()
            outside.mkdir()
            (vault / "symlink").symlink_to(outside, target_is_directory=True)
            for subfolder in ["../outside", "symlink"]:
                with self.assertRaises(DestinationError):
                    Obsidian(
                        {
                            "kind": "obsidian",
                            "vault": str(vault),
                            "folder": subfolder,
                            "target_id": "fixture-target",
                        }
                    ).probe()
            self.assertEqual(list(outside.iterdir()), [])

    def test_plain_credentials_rejected_and_profile_never_accepts_code(self):
        for data in [
            {
                "kind": "ima",
                "target_id": "fixture-target",
                "client_id": "fixture-client",
                "api_key": "plaintext-key",
            },
            {
                "kind": "obsidian",
                "target_id": "fixture-target",
                "vault": "/tmp",
                "command": "arbitrary shell",
            },
        ]:
            with self.assertRaises(DestinationError):
                validate(data)
