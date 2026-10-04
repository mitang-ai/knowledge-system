/** Real browser + real local backend, isolated temporary data only. */
import { createRequire } from "node:module";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch {
  ({ chromium } = require(join(process.env.CODEX_NODE_MODULES || join(process.env.USERPROFILE || "", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules"), "playwright")));
}
const python = process.env.PYTHON || join(root, ".venv", "Scripts", "python.exe");
const storage = await mkdtemp(join(tmpdir(), "sediment-auth-"));
const output = join(root, "test-results", "auth"); await mkdir(output, { recursive: true });
const port = await new Promise((done) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => done(p)); }); });
const origin = `http://127.0.0.1:${port}`;
const backend = spawn(python, [join(root, "server", "app.py")], {
  cwd: root, windowsHide: true, stdio: "ignore",
  env: { ...process.env, SEDIMENT_STORAGE: storage, SEDIMENT_PORT: String(port), SEDIMENT_ENV: "local", SEDIMENT_OWNER: "", SEDIMENT_SEED_DIR: "", SEDIMENT_QUIET: "1" },
});
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { ready = (await fetch(origin + "/api/health")).ok; } catch {} if (ready) break; await new Promise((done) => setTimeout(done, 100)); }
  assert(ready, "isolated backend did not start");
  const owner = await fetch(origin + "/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@example.test", password: "synthetic-owner-password", display_name: "隔离测试所有者" }) });
  assert.equal(owner.status, 200);
  const cookie = owner.headers.get("set-cookie").split(";")[0];
  const privateNote = await fetch(origin + "/api/items", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ id: "auth-private-note", type: "note", title: "隔离测试私有记录", body: "其他账号不能读取", topic_ids: [], atts: [] }) });
  assert.equal(privateNote.status, 200);
  browser = await chromium.launch({ headless: true, ...(process.env.SEDIMENT_CHROMIUM ? { executablePath: process.env.SEDIMENT_CHROMIUM } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage(), errors = [], registrations = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.url().endsWith("/api/register")) registrations.push(request.postDataJSON()); });
  await page.goto(origin, { waitUntil: "networkidle" });
  assert(await page.getByText("请妥善保管自己的账号和密码", { exact: true }).isVisible());
  await page.screenshot({ path: join(output, "login-desktop.png"), fullPage: true });
  const registered = page.waitForResponse((response) => response.url().endsWith("/api/register") && response.request().method() === "POST");
  await page.getByRole("button", { name: "一键创建账号密码", exact: true }).click();
  assert.equal((await registered).status(), 200);
  await page.getByRole("heading", { name: "账号已创建，请先保存", exact: true }).waitFor();
  const fields = page.locator(".auth-credentials input[readonly]");
  const email = await fields.nth(0).inputValue(), password = await fields.nth(1).inputValue();
  assert.match(email, /^sd_[a-f0-9]{24}@account\.invalid$/); assert.match(password, /^Sd![a-f0-9]{32}$/);
  assert.equal(registrations.length, 1);
  assert(await page.getByRole("button", { name: "进入我的知识空间", exact: true }).isDisabled());
  const browserStorage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert(!browserStorage.includes(email) && !browserStorage.includes(password));
  await page.getByRole("button", { name: "复制账密", exact: true }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert(copied.includes(email) && copied.includes(password) && copied.includes("明文密码"));
  const downloaded = page.waitForEvent("download"); await page.getByRole("button", { name: "下载保存卡", exact: true }).click();
  const download = await downloaded;
  const exported = await readFile(await download.path(), "utf8");
  assert(exported.includes(email) && exported.includes(password) && exported.includes("不是邮箱"));
  await download.delete(); await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.screenshot({ path: join(output, "save-card-desktop.png"), fullPage: true, mask: [fields] });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.getByRole("button", { name: "下载保存卡", exact: true }).isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(output, "save-card-mobile.png"), fullPage: true, mask: [fields] });
  await page.getByLabel("我已妥善保存账号和密码", { exact: true }).check();
  await page.getByRole("button", { name: "进入我的知识空间", exact: true }).click();
  await page.getByRole("heading", { name: "我的知识空间", exact: true }).waitFor();
  const stateResponse = await context.request.get(origin + "/api/state"); assert.equal(stateResponse.status(), 200);
  const state = await stateResponse.json(); assert.equal(state.items.length, 0); assert.equal(state.me.display_name, "新的思考者");
  assert.equal((await context.request.post(origin + "/api/logout", { data: {} })).status(), 200);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByLabel("邮箱 / 登录账号", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "我的知识空间", exact: true }).waitFor();
  assert.equal((await (await context.request.get(origin + "/api/state")).json()).me.owner_id, state.me.owner_id);
  const manual = await browser.newContext(), manualPage = await manual.newPage();
  await manualPage.goto(origin, { waitUntil: "networkidle" });
  await manualPage.getByRole("button", { name: "没有账号，创建一个个人空间" }).click();
  await manualPage.getByLabel("显示名", { exact: true }).fill("手动注册测试");
  await manualPage.getByLabel("邮箱", { exact: true }).fill("manual@example.test");
  await manualPage.getByLabel("密码", { exact: true }).fill("synthetic-manual-password");
  await manualPage.getByRole("button", { name: "创建账号", exact: true }).click();
  await manualPage.getByRole("heading", { name: "我的知识空间", exact: true }).waitFor();
  const dbCheck = JSON.parse(execFileSync(python, ["-c", "import sqlite3,json,sys,pathlib; d=sqlite3.connect(pathlib.Path(sys.argv[1])/'workspace.sqlite3'); print(json.dumps({'accounts': d.execute('select count(*) from accounts').fetchone()[0], 'plain_matches':d.execute('select count(*) from accounts where password=?',(sys.argv[2],)).fetchone()[0]}))", storage, password], { windowsHide: true, encoding: "utf8" }));
  assert.equal(dbCheck.accounts, 3); assert.equal(dbCheck.plain_matches, 0); assert.deepEqual(errors, []);
  await writeFile(join(output, "verification.json"), JSON.stringify({ passed: true, cases: ["quick signup + session", "explicit save acknowledgement", "clipboard export", "download export", "no plaintext browser persistence", "mobile no overflow", "private data isolation", "logout + credential login", "manual signup", "password hashing", "no browser runtime errors"], accountCount: dbCheck.accounts }, null, 2));
  console.log("PASS: 11 isolated real-browser auth checks; no production requests.");
} finally {
  if (browser) await browser.close();
  const exited = new Promise((done) => backend.once("exit", done));
  if (backend.exitCode === null) {
    // The Windows venv launcher may have a child interpreter holding SQLite files.
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(backend.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else backend.kill();
    await exited;
  }
  assert.equal(dirname(resolve(storage)), resolve(tmpdir()));
  assert(basename(storage).startsWith("sediment-auth-"));
  await rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
