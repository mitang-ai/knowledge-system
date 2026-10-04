/** README artwork only: render synthetic notes in an isolated local workspace. */
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch {
  const modules = process.env.CODEX_NODE_MODULES || join(process.env.USERPROFILE || "", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules");
  ({ chromium } = require(join(modules, "playwright")));
}
const storage = await mkdtemp(join(tmpdir(), "sediment-readme-"));
const port = await new Promise((done) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => done(port)); });
});
const origin = `http://127.0.0.1:${port}`;
const backend = spawn(process.env.PYTHON || "python", [join(root, "server", "app.py")], {
  cwd: root, windowsHide: true, stdio: "ignore",
  env: { ...process.env, SEDIMENT_STORAGE: storage, SEDIMENT_PORT: String(port), SEDIMENT_ENV: "local", SEDIMENT_SEED_DIR: "", SEDIMENT_OWNER: "", SEDIMENT_QUIET: "1", PYTHONUTF8: "1" },
});
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(origin + "/api/health")).ok; } catch {}
    if (ready) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert(ready, "isolated screenshot backend did not start");
  const api = async (path, body) => {
    const response = await fetch(origin + "/api/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, `fixture request failed: ${path}`);
    return response.json();
  };
  await api("profile", { display_name: "示例用户" });
  const item = (id, title, body, type = "note", topics = []) => ({ id, title, body, type, topic_ids: topics, atts: [], starred: false });
  await api("items", item("demo-writing", "阅读与写作", "读过的句子，还有自己写下的几句话。", "topic"));
  await api("items", item("demo-building", "做东西的过程", "把遇到的问题和解决办法留在一起。", "topic"));
  await api("items", item("demo-everyday", "日常观察", "值得回来再看一眼的小事。", "topic"));
  let note = await api("items", item("demo-capture", "先记下来，别急着归类", "分类太早，会打断一个还没成形的想法。先放进收件箱，等积累几条，再看它们之间的关系。", "note", ["demo-writing"]));
  const reply = await api("replies", { id: "demo-understanding", item_id: note.id, body: "先把原话留住。分类可以改，自己的理解也可以接着写。", atts: [], is_progress: true });
  note = await api("items", { ...note, revision: reply.item_revision, und: reply.id });
  await api("items", item("demo-language", "一段话写不清，先改动词", "把‘进行了深入分析’换成‘对照三次记录，找出变化’。动作写清楚了，读者才知道发生了什么。", "note", ["demo-writing"]));
  await api("items", item("demo-logs", "用日志回答：到底发生了什么", "先留住输入、时间和结果，再解释原因。查不到的那一步，单独记下来。", "note", ["demo-building"]));
  await api("items", item("demo-reading", "读完之后，留下一句话", "合上文章，写一句自己记住的话。隔天再看，能说清为什么留下它，才算有了自己的理解。", "experience", ["demo-writing"]));
  await api("items", item("demo-attention", "关于注意力的几条观察", "读到一半换窗口，回来时经常要重读。下次试着先看完一个小段，再处理别的事。", "resource", ["demo-everyday"]));
  await api("items", item("demo-loose", "今晚散步时想到的事", "几个词还没连起来，先留在这里。"));
  browser = await chromium.launch({ headless: true, ...(process.env.SEDIMENT_CHROMIUM ? { executablePath: process.env.SEDIMENT_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, timezoneId: "America/Los_Angeles" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "我的知识空间", exact: true }).waitFor();
  await page.locator("#quick-note").fill("刚读到一个有意思的说法，先把自己的问题记下来……");
  await page.evaluate(() => document.fonts.ready);
  assert.deepEqual(errors, []);
  assert(await page.getByText("理解在更新", { exact: true }).isVisible());
  const output = join(root, "docs", "readme", "assets", "workspace.png");
  await mkdir(dirname(output), { recursive: true });
  await page.screenshot({ path: output, fullPage: true });
  console.log("README screenshot saved; synthetic content, no production requests.");
} finally {
  if (browser) await browser.close();
  if (backend.exitCode === null) {
    const exited = new Promise((done) => backend.once("exit", done));
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(backend.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else backend.kill();
    await exited;
  }
  assert.equal(dirname(resolve(storage)), resolve(tmpdir()));
  assert(basename(storage).startsWith("sediment-readme-"));
  await rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
