"""Real browser + local connector; synthetic data and temporary storage only."""

import base64, hashlib, json, os, re, socket, subprocess, sys, tempfile, time, urllib.parse, urllib.request
import sqlite3, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from sediment import Client
from sediment.runner import run_plan
from sediment.profiles import save_profiles

SECRET = "browser-connect-fixture-only-key"
provider_calls = []


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, status=200, mime="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,Authorization")
        self.send_header("Access-Control-Allow-Methods", "POST,OPTIONS")
        self.end_headers()

    def do_OPTIONS(self):
        self.respond(204)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        provider_calls.append(
            {"body": body, "authorization": self.headers.get("Authorization")}
        )
        self.respond(mime="text/event-stream")
        events = [
            {
                "type": "response.output_text.delta",
                "delta": "## 经核对的整理稿\n保留原始观察与思考 [S1]。\n" + SECRET,
            },
            {
                "type": "response.completed",
                "response": {"model": "fixture-model-20261002"},
            },
        ]
        for event in events:
            self.wfile.write(
                ("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode()
            )
            self.wfile.flush()


out = ROOT / "test-results"
out.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory() as folder:
    root = Path(folder)
    vault = root / "vault"
    vault.mkdir()
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "server/app.py")],
        env={
            **os.environ,
            "SEDIMENT_STORAGE": str(root / "server"),
            "SEDIMENT_PORT": str(port),
            "SEDIMENT_QUIET": "1",
        },
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(80):
            try:
                urllib.request.urlopen(url + "/api/health")
                break
            except Exception:
                time.sleep(0.05)
        with sync_playwright() as p:
            browser = p.chromium.launch(
                executable_path=os.environ.get(
                    "SEDIMENT_CHROMIUM", "/usr/bin/chromium"
                ),
                headless=True,
                args=["--no-sandbox"],
            )
            context = browser.new_context(viewport={"width": 1440, "height": 1000})
            page = context.new_page()
            errors = []
            failed = []
            system_requests = []
            page.on(
                "request",
                lambda request: (
                    system_requests.append(
                        {"headers": request.headers, "body": request.post_data or ""}
                    )
                    if request.url.startswith(url + "/api/")
                    else None
                ),
            )
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on(
                "response",
                lambda r: (
                    failed.append((r.status, r.url))
                    if r.status >= 400 and "/api/" in r.url
                    else None
                ),
            )
            register = context.request.post(
                url + "/api/register",
                headers={"Origin": url},
                data={
                    "email": "browser-open@example.test",
                    "password": "browser-open-password",
                    "display_name": "浏览器合成用户",
                },
            )
            assert register.status == 200
            response = context.request.post(
                url + "/api/items",
                headers={"Origin": url},
                data={
                    "id": "browser-open-note",
                    "type": "note",
                    "title": "写给未来的研究记录",
                    "body": "保留原始观察与思考。\n\n排除的合成片段。",
                    "atts": [],
                    "topic_ids": [],
                },
            )
            assert response.status == 200
            item = response.json()
            page.goto(url, wait_until="networkidle")
            owner = context.request.get(url + "/api/state").json()["me"]["owner_id"]
            config = {
                "version": 1,
                "connections": [
                    {
                        "id": "fixture-provider",
                        "name": "研究模型",
                        "protocol": "openai",
                        "baseUrl": f"http://127.0.0.1:{provider.server_port}/v1",
                        "key": SECRET,
                        "remember": True,
                        "apiType": "responses",
                        "models": [
                            {
                                "id": "fixture-model-20261002",
                                "name": "fixture-model-20261002",
                                "enabled": True,
                            }
                        ],
                    }
                ],
                "defaultModel": "fixture-provider::fixture-model-20261002",
                "maxTokens": 2048,
            }
            page.evaluate(
                "([owner, config]) => localStorage.setItem('sediment-ai:v1:' + owner, JSON.stringify(config))",
                [owner, config],
            )
            page.reload(wait_until="networkidle")
            page.get_by_role("button", name="偏好设置", exact=True).click()
            page.get_by_role("button", name="连接与迁移", exact=True).click()
            page.get_by_role("button", name="授权 Agent", exact=True).click()
            page.get_by_label("Agent名称", exact=True).fill("浏览器研究助手")
            for name in [
                "提交待采纳建议",
                "生成外部沉淀计划",
                "执行已批准计划",
                "读取增量变化",
            ]:
                page.get_by_label(name, exact=True).check()
            page.get_by_role("button", name="创建授权", exact=True).click()
            expect(page.get_by_role("dialog", name="保存访问令牌")).to_be_visible()
            token = page.get_by_label("一次性访问令牌").input_value()
            assert token.startswith("sd_")
            page.get_by_role("button", name="我已保存", exact=True).click()
            expect(page.locator(".connections")).to_contain_text("浏览器研究助手")
            assert token not in page.evaluate("JSON.stringify({...localStorage})")
            page.screenshot(path=str(out / "open-agents-light.png"), full_page=True)
            page.get_by_role("button", name="切换到深色", exact=True).click()
            page.get_by_role("button", name="沉淀目的地", exact=True).click()
            page.get_by_role("button", name="添加目的地", exact=True).click()
            page.get_by_label("本地 Obsidian 仓库完整路径", exact=True).fill(str(vault))
            page.get_by_role("button", name="保存本地配置", exact=True).click()
            page.screenshot(
                path=str(out / "open-destinations-dark.png"), full_page=True
            )
            profiles = (
                page.evaluate(
                    "JSON.parse(localStorage.getItem('sediment-destinations:'+JSON.parse(document.querySelector('script[type=application/json]')?.textContent||'{}').owner)||'null')"
                )
                if False
                else page.evaluate(
                    "Object.entries(localStorage).filter(([k])=>k.startsWith('sediment-destinations:')).map(([,v])=>JSON.parse(v))[0]"
                )
            )
            profile = profiles[0]
            sdk = Client(url, token)
            source = sdk.read(item["id"])
            proposal = sdk.propose(
                {
                    "space_id": "personal",
                    "action": "append_reply",
                    "target_item_id": item["id"],
                    "base_revision": source["revision"],
                    "content": "Agent 的合成待采纳发现",
                    "source_refs": [
                        {
                            "item_id": item["id"],
                            "revision": source["revision"],
                            "part_id": source["fragments"][0]["part_id"],
                        }
                    ],
                },
                "browser-proposal",
            )
            page.get_by_role("button", name=re.compile("^收件箱")).click()
            expect(page.locator(".operations-compact")).to_contain_text(
                "Agent 的合成待采纳发现"
            )
            page.locator(".operations-compact").get_by_role(
                "button", name="审核", exact=True
            ).click()
            page.get_by_label("审核内容", exact=True).fill("人工核对后的合成发现")
            page.get_by_role("button", name="采纳到知识空间", exact=True).click()
            expect(page.locator(".operations-compact")).to_have_count(0)
            page.locator(".note-open").filter(has_text="写给未来的研究记录").click()
            page.get_by_role("dialog", name="知识详情").get_by_role(
                "button", name="提取与沉淀", exact=True
            ).click()
            page.get_by_role("button", name="生成知识包", exact=True).click()
            expect(page.get_by_label("沉淀稿件")).to_have_value(
                re.compile("排除的合成片段")
            )
            page.get_by_text("精确选择片段 · 来源定位", exact=True).click()
            page.locator(".fragment-picker input").nth(1).uncheck()
            assert "排除的合成片段" not in page.get_by_label("沉淀稿件").input_value()
            page.get_by_role("button", name="用我的 AI 整理", exact=True).click()
            expect(page.get_by_label("沉淀稿件")).to_have_value(
                re.compile("经核对的整理稿.*已隐藏凭据", re.S)
            )
            expect(
                page.get_by_role("button", name="用我的 AI 整理", exact=True)
            ).to_be_enabled()
            assert provider_calls[-1]["authorization"] == "Bearer " + SECRET
            sent = json.dumps(provider_calls[-1]["body"], ensure_ascii=False)
            assert SECRET not in sent and "排除的合成片段" not in sent
            page.get_by_label("沉淀目的地", exact=True).select_option(profile["id"])
            with page.expect_response(
                lambda r: "/export-plans/" in r.url and "/approve" in r.url
            ) as approved:
                page.get_by_role("button", name="确认稿件与目标", exact=True).click()
            assert approved.value.status == 200
            plan_id = approved.value.json()["id"]
            expect(page.locator(".connect-success")).to_contain_text("等待本地连接器")
            header = (
                page.get_by_role("dialog", name="提取与沉淀")
                .locator(".modal-heading")
                .bounding_box()
            )
            assert header and header["y"] >= -1, header
            modal = page.get_by_role("dialog", name="提取与沉淀").bounding_box()
            assert (
                modal and modal["y"] >= 0 and modal["y"] + modal["height"] <= 1000
            ), modal
            page.screenshot(path=str(out / "open-extract-dark.png"), full_page=True)
            with patch.dict(os.environ, {"SEDIMENT_CONFIG_DIR": str(root / "local")}):
                save_profiles(
                    {
                        "sources": {},
                        "destinations": {
                            profile["id"]: {
                                k: v
                                for k, v in profile.items()
                                if k not in ("id", "name")
                            }
                        },
                    }
                )
                receipt = run_plan(sdk, plan_id, profile["id"])
                assert (
                    receipt["status"] == "completed" and receipt["read_back_verified"]
                )
            path = vault / "沉淀" / receipt["destination_item_id"]
            assert "排除的合成片段" not in path.read_text()
            assert "sediment_source:" in path.read_text()
            assert "/?item=" in path.read_text()
            assert SECRET not in path.read_text()
            page.get_by_role("dialog", name="提取与沉淀").get_by_role(
                "button", name="关闭", exact=True
            ).click()
            page.get_by_role("dialog", name="知识详情").get_by_role(
                "button", name="关闭", exact=True
            ).click()
            page.get_by_role("button", name="偏好设置", exact=True).click()
            page.get_by_role("button", name="连接与迁移", exact=True).click()
            page.get_by_role("button", name="建议与执行", exact=True).click()
            expect(page.locator(".operations-panel")).to_contain_text(
                "本地连接器已回读"
            )
            page.screenshot(path=str(out / "open-operations-dark.png"), full_page=True)
            for width in [390, 320]:
                page.set_viewport_size({"width": width, "height": 844})
                for label in [
                    "Agent 授权",
                    "沉淀目的地",
                    "建议与执行",
                    "增量规则",
                    "访问记录",
                    "团队策略",
                ]:
                    page.get_by_role("button", name=label, exact=True).click()
                    assert page.evaluate(
                        "document.documentElement.scrollWidth<=innerWidth+1"
                    ), (width, label)
                page.screenshot(
                    path=str(out / f"open-mobile-{width}.png"), full_page=True
                )
            # The actual human OAuth consent page narrows the requested range.
            page.set_viewport_size({"width": 1440, "height": 1000})
            callback = f"http://127.0.0.1:{provider.server_port}/callback"
            registered = context.request.post(
                url + "/oauth/register",
                data={"client_name": "浏览器 OAuth 助手", "redirect_uris": [callback]},
            ).json()
            verifier = "v" * 64
            params = {
                "client_id": registered["client_id"],
                "redirect_uri": callback,
                "response_type": "code",
                "code_challenge_method": "S256",
                "code_challenge": base64.urlsafe_b64encode(
                    hashlib.sha256(verifier.encode()).digest()
                )
                .decode()
                .rstrip("="),
                "resource": "http://127.0.0.1:8791/mcp",
                "scope": "knowledge:read history:read",
                "state": "browser-flow",
            }
            authorize = context.request.get(
                url + "/oauth/authorize?" + urllib.parse.urlencode(params),
                max_redirects=0,
            )
            assert authorize.status == 302
            page.route(
                callback + "?**",
                lambda route: route.fulfill(body="OAuth callback fixture"),
            )
            page.goto(authorize.headers["location"], wait_until="networkidle")
            expect(page.locator(".oauth-consent")).to_contain_text("浏览器 OAuth 助手")
            page.get_by_label("历史修订", exact=True).check()
            expect(page.get_by_label("读取历史修订", exact=True)).to_be_checked()
            page.get_by_label("读取历史修订", exact=True).uncheck()
            expect(page.get_by_label("历史修订", exact=True)).not_to_be_checked()
            assert page.get_by_label("提交待采纳建议", exact=True).count() == 0
            page.get_by_role("button", name="允许所选范围", exact=True).click()
            page.wait_for_url(callback + "?**")
            code = urllib.parse.parse_qs(urllib.parse.urlparse(page.url).query)["code"][
                0
            ]
            exchanged = context.request.post(
                url + "/oauth/token",
                data={
                    "grant_type": "authorization_code",
                    "client_id": registered["client_id"],
                    "redirect_uri": callback,
                    "resource": params["resource"],
                    "code": code,
                    "code_verifier": verifier,
                },
            )
            assert exchanged.status == 200
            assert Client(url, exchanged.json()["access_token"]).read(item["id"])[
                "fragments"
            ]
            # Legacy personal attitude cannot become a verified experience.
            experience = context.request.post(
                url + "/api/items",
                headers={"Origin": url},
                data={
                    "id": "browser-experience",
                    "type": "experience",
                    "title": "合成实践经验",
                    "body": "先写下观察，再记录适用条件。",
                    "exp_st": "我尝试过",
                    "atts": [],
                    "topic_ids": [],
                },
            )
            assert experience.status == 200
            page.goto(url + "/?item=browser-experience", wait_until="networkidle")
            expect(page.locator(".validation-card")).to_contain_text("尚未验证")
            page.get_by_role("button", name="记录验证", exact=True).click()
            page.get_by_label("验证判断", exact=True).select_option("supported")
            page.get_by_label("适用条件", exact=True).fill("合成试验场景")
            page.get_by_label("观察与结果", exact=True).fill("人工观察的合成结果")
            page.get_by_role("button", name="保存验证记录", exact=True).click()
            expect(page.locator(".validation-card")).to_contain_text("有实践支持")
            assert SECRET not in json.dumps(system_requests)
            db = sqlite3.connect(root / "server/workspace.sqlite3")
            assert SECRET not in "\n".join(db.iterdump())
            db.close()
            assert not errors, errors
            assert not failed, failed
            browser.close()
        print(
            "PASS: one-time grants, local destinations, Agent proposal/adoption, precise extraction, browser-only AI draft/privacy, approval, actual Obsidian write/read-back, human OAuth/PKCE consent, independent validation, audit and 320/390px layouts; no browser errors or failed requests."
        )
    finally:
        server.terminate()
        server.wait(timeout=5)
        provider.shutdown()
        provider.server_close()
