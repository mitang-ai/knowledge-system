/** Synthetic, local-only MV3 integration. Never uses deployed accounts or real AI. */
import { createRequire } from "node:module";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, cp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  const bundled =
    process.env.CODEX_NODE_MODULES ||
    join(
      process.env.USERPROFILE || "",
      " .cache".trim(),
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "node",
      "node_modules",
    );
  ({ chromium } = require(join(bundled, "playwright")));
}
const output = join(
  root,
  "test-results",
  "extension",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
await mkdir(output, { recursive: true });
const artifact = join(root, "build", "browser-extension", "unpacked"),
  fixtureExtension = join(output, "fixture-extension");
await cp(artifact, fixtureExtension, { recursive: true });
const manifest = JSON.parse(
  await readFile(join(fixtureExtension, "manifest.json"), "utf8"),
);
assert(
  !manifest.host_permissions,
  "Shipping package must have no persistent hosts",
);
assert(!manifest.content_scripts && !manifest.externally_connectable);
// Test-only grant replaces a native browser permission prompt that automation cannot approve.
// The shipped manifest stays unchanged. No security flags or production hosts are used.
manifest.host_permissions = ["http://127.0.0.1/*"];
await writeFile(
  join(fixtureExtension, "manifest.json"),
  JSON.stringify(manifest),
);
const freePort = () =>
  new Promise((resolve) => {
    const s = tcpServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
const port = await freePort(),
  origin = "http://127.0.0.1:" + port;
const python =
  process.env.PYTHON || join(root, ".venv", "Scripts", "python.exe");
const backend = spawn(python, [join(root, "server", "app.py")], {
  cwd: root,
  windowsHide: true,
  env: {
    ...process.env,
    SEDIMENT_STORAGE: join(output, "storage"),
    SEDIMENT_PORT: String(port),
    SEDIMENT_ENV: "local",
    SEDIMENT_SEED_DIR: "",
    SEDIMENT_OWNER: "",
    SEDIMENT_QUIET: "1",
  },
  stdio: "ignore",
});
let context, fixtureServer;
const errors = [],
  providerCalls = [],
  systemRequests = [];
try {
  let up = false;
  for (let i = 0; i < 100; i++) {
    try {
      up = (await fetch(origin + "/api/health")).ok;
    } catch {}
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(up, "Isolated app failed to start");
  let cookie = "";
  const interactive = async (path, body) => {
    const r = await fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-Sediment-Interactive": "1",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.headers.get("set-cookie"))
      cookie = r.headers.get("set-cookie").split(";")[0];
    const v = await r.json();
    assert(r.ok, "Synthetic setup failed: " + path + " HTTP " + r.status);
    return v;
  };
  await interactive("/api/register", {
    email: "extension-fixture@example.test",
    password: "synthetic-local-test-only",
    display_name: "本机验收账号",
  });
  const grant = await interactive("/api/v1/grants", {
    name: "本机插件验收",
    space_ids: ["personal"],
    fields: ["original", "current_understanding", "provenance"],
    scopes: ["knowledge:read", "knowledge:write", "proposals:create"],
    allowed_write_actions: ["create_note"],
    max_new_items_per_day: 30,
    dynamic_membership: true,
  });
  assert(grant.token, "Synthetic scope grant missing");
  const articleText =
    "好的记录不是立即完成分类，而是保留原始材料、自己的理解与尚未解决的问题。每次回看时再补充证据，才能让知识逐步形成连接。";
  fixtureServer = createServer(async (req, res) => {
    if (req.url === "/article") {
      res.setHeader("Content-Type", "text/html;charset=utf-8");
      res.end(
        `<html><head><title>把阅读变成自己的理解</title></head><body><nav>不应捕获的导航</nav><article><h1>把阅读变成自己的理解</h1><p>${articleText.repeat(7)}</p><h2>下一步行动</h2><p>先写下一句自己的看法，然后保留文章来源。</p><img src="/diagram.png" alt="知识连接示意图"></article><form><textarea>不应读取的表单秘密</textarea></form></body></html>`,
      );
      return;
    }
    if (req.url === "/v1/models") {
      providerCalls.push({
        path: req.url,
        authorization: req.headers.authorization,
      });
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ id: "fixture-summary-v1" }, { id: "fixture-insight-v2" }],
        }),
      );
      return;
    }
    if (req.url === "/v1/chat/completions") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const v = JSON.parse(body);
      providerCalls.push({
        path: req.url,
        authorization: req.headers.authorization,
        body: v,
      });
      assert.equal(req.headers.authorization, "Bearer synthetic-ai-sentinel");
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        "data: " +
          JSON.stringify({
            model: "fixture-actual-v1",
            choices: [
              {
                delta: {
                  content:
                    "材料要点：保留原文，再补充自己的理解。\n\n待验证问题：怎样持续回顾？ [S1]",
                },
                finish_reason: null,
              },
            ],
          }) +
          "\n\ndata: " +
          JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
          "\n\ndata: [DONE]\n\n",
      );
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise((r) => fixtureServer.listen(0, "127.0.0.1", r));
  const provider = "http://127.0.0.1:" + fixtureServer.address().port;
  const executable =
    process.env.CHROMIUM_EXECUTABLE ||
    join(
      process.env.LOCALAPPDATA || "",
      "ms-playwright",
      "chromium-1243",
      "chrome-win64",
      "chrome.exe",
    );
  context = await chromium.launchPersistentContext(join(output, "profile"), {
    executablePath: executable,
    headless: true,
    viewport: { width: 390, height: 1000 },
    colorScheme: "light",
    args: [
      "--disable-extensions-except=" + fixtureExtension,
      "--load-extension=" + fixtureExtension,
    ],
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 20000 }));
  const id = new URL(worker.url()).host;
  const pane = await context.newPage();
  pane.on("pageerror", (e) => errors.push(e.message));
  context.on("request", (r) => {
    if (r.url().startsWith(origin))
      systemRequests.push({ url: r.url(), body: r.postData() });
  });
  await pane.goto("chrome-extension://" + id + "/panel.html");
  await pane.getByRole("textbox", { name: "我的想法" }).waitFor();
  await pane.screenshot({
    path: join(output, "01-compose.png"),
    fullPage: true,
  });
  await pane
    .getByRole("textbox", { name: "我的想法" })
    .fill("本机验收草稿：先留下一句话，再慢慢整理。");
  await pane.getByText("草稿已保存在本机", { exact: true }).waitFor();
  await pane.reload();
  await pane.getByRole("button", { name: /草稿/ }).click();
  await pane
    .getByText("本机验收草稿：先留下一句话，再慢慢整理。", { exact: true })
    .first()
    .waitFor();
  await pane.getByRole("button", { name: "打开插件设置" }).click();
  await pane
    .getByRole("textbox", { name: "系统地址", exact: true })
    .fill(origin);
  await pane.getByText("手动令牌与高级连接", { exact: true }).click();
  await pane
    .getByRole("textbox", { name: "范围授权令牌", exact: true })
    .fill(grant.token);
  await pane.getByRole("button", { name: "验证并连接", exact: true }).click();
  await pane.getByText("已连接", { exact: true }).waitFor();
  await pane.getByRole("button", { name: "AI 与模型", exact: true }).click();
  await pane.getByRole("button", { name: "添加 AI 服务", exact: true }).click();
  await pane
    .getByRole("textbox", { name: "服务名称", exact: true })
    .fill("本机验收模型");
  await pane
    .getByRole("textbox", { name: "API 根地址", exact: true })
    .fill(provider + "/v1");
  await pane
    .getByRole("textbox", { name: "API Key", exact: true })
    .fill("synthetic-ai-sentinel");
  await pane.getByRole("button", { name: "探测模型", exact: true }).click();
  await pane.getByText("fixture-summary-v1", { exact: true }).first().waitFor();
  await pane.locator(".model-row").nth(0).getByRole("checkbox").check();
  await pane.locator(".model-row").nth(1).getByRole("checkbox").check();
  await pane.screenshot({
    path: join(output, "02-models.png"),
    fullPage: true,
  });
  await pane
    .getByRole("button", { name: "保存服务与模型", exact: true })
    .click();
  await pane.getByText("2 个常用模型", { exact: false }).waitFor();
  const storageCheck = await pane.evaluate(async () => ({
    local: JSON.stringify(await chrome.storage.local.get(null)),
    session: JSON.stringify(await chrome.storage.session.get(null)),
    sync: JSON.stringify(await chrome.storage.sync.get(null)),
  }));
  assert(!storageCheck.local.includes("synthetic-ai-sentinel"));
  assert(storageCheck.session.includes("synthetic-ai-sentinel"));
  assert(!storageCheck.sync.includes("synthetic-ai-sentinel"));
  await pane.getByRole("button", { name: "回到随手记", exact: true }).click();
  const article = await context.newPage();
  await article.goto(provider + "/article");
  const capture = await worker.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({ url }))[0];
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["capture.js"],
    });
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => globalThis.__sedimentCaptureV1(false),
    });
    const c = result[0].result,
      a = (await chrome.storage.local.get("auth:v1"))["auth:v1"];
    await chrome.storage.session.set({
      ["pending-capture:v1:" + tab.windowId]: {
        capture: c,
        owner: a.origin + "|" + a.subject,
        at: Date.now(),
      },
    });
    return c;
  }, provider + "/article");
  assert.equal(
    await article.evaluate(() => typeof globalThis.__sedimentCaptureV1),
    "undefined",
    "Capture hook must stay in isolated world",
  );
  assert(capture.text.includes(articleText));
  assert(!capture.text.includes("表单秘密"));
  assert.equal(capture.source.coverage, "extracted-article");
  await pane.getByText("这一刻，有什么启发？", { exact: true }).waitFor();
  await pane
    .getByRole("textbox", { name: "我的想法" })
    .fill("我的理解：记录动作要轻，回顾动作要认真。");
  await pane
    .getByRole("button", { name: "想借助自己的 AI？", exact: true })
    .click();
  await pane.getByRole("button", { name: "开始整理", exact: true }).click();
  await pane.getByText("整理完成，等待你核对", { exact: true }).waitFor();
  await pane
    .getByRole("checkbox", { name: "将这份整理与原文一起沉淀", exact: true })
    .check();
  await pane.screenshot({
    path: join(output, "03-capture-ai.png"),
    fullPage: true,
  });
  assert.equal(
    providerCalls.filter((c) => c.path === "/v1/chat/completions").length,
    1,
    "Selecting favorites must not invoke both",
  );
  assert(
    providerCalls
      .find((c) => c.body)
      ?.body.messages.at(-1)
      .content.includes(articleText),
  );
  await pane
    .getByRole("button", { name: "沉淀到我的空间", exact: true })
    .click();
  await pane.getByRole("button", { name: /草稿/ }).click();
  await pane.getByText("已沉淀", { exact: true }).waitFor();
  await pane.screenshot({
    path: join(output, "04-confirmed.png"),
    fullPage: true,
  });
  const snapshot = await pane.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: "state" });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  });
  const record = snapshot.queue.find((r) => r.id === capture.id);
  assert.equal(record.status, "saved");
  assert(record.result.item_id);
  const replay = await fetch(origin + "/api/v1/write", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + grant.token,
      "Content-Type": "application/json",
      "Idempotency-Key": "clip-v1:" + record.id,
    },
    body: JSON.stringify(record.payload),
  });
  assert(replay.ok);
  const replayResult = await replay.json();
  assert.equal(replayResult.item_id, record.result.item_id);
  const documents = (await interactive("/api/state")).items;
  const item = documents.find((i) => i.id === record.result.item_id);
  assert(item, "Authoritative readback not found");
  assert(item.body.includes(capture.text));
  assert(item.body.includes("我的理解：记录动作要轻，回顾动作要认真。"));
  assert(item.body.includes("## AI 整理"));
  assert(!JSON.stringify(item).includes("synthetic-ai-sentinel"));
  assert.equal(
    documents.filter((i) => i.id === record.result.item_id).length,
    1,
  );
  assert(
    !systemRequests.some((r) => r.body?.includes("synthetic-ai-sentinel")),
    "AI Key must never reach system",
  );
  assert(
    !snapshot.drafts.some((d) => d.id === capture.id),
    "Confirmed capture must not resurrect as a draft",
  );
  await pane.setViewportSize({ width: 320, height: 900 });
  const dimensions = await pane.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  assert(dimensions.scroll <= dimensions.width, "Narrow panel overflow");
  await pane.emulateMedia({ colorScheme: "dark" });
  await pane.screenshot({
    path: join(output, "05-dark-narrow.png"),
    fullPage: true,
  });
  // Switch real synthetic accounts and reload: an old pending capture cannot reappear under B.
  await interactive("/api/register", {
    email: "extension-second@example.test",
    password: "synthetic-second-only",
    display_name: "第二个验收账号",
  });
  const other = await interactive("/api/v1/grants", {
    name: "第二个账号授权",
    space_ids: ["personal"],
    fields: ["original", "provenance"],
    scopes: ["knowledge:read", "knowledge:write"],
    allowed_write_actions: ["create_note"],
    max_new_items_per_day: 10,
    dynamic_membership: true,
  });
  const switchResult = await pane.evaluate(
    async ({ origin, token }) =>
      chrome.runtime.sendMessage({ type: "auth.token", origin, token }),
    { origin, token: other.token },
  );
  assert(switchResult.ok);
  await pane.reload();
  await pane.getByRole("textbox", { name: "我的想法" }).waitFor();
  assert.equal(
    await pane.getByRole("textbox", { name: "我的想法" }).inputValue(),
    "",
  );
  assert.equal(await pane.locator(".source-card").count(), 0);
  const otherState = await pane.evaluate(
    async () => (await chrome.runtime.sendMessage({ type: "state" })).data,
  );
  assert.equal(otherState.queue.length, 0);
  assert(!otherState.drafts.some((d) => d.id === capture.id));
  const denied = await pane.evaluate(
    async ({ capture, owner }) =>
      chrome.runtime.sendMessage({ type: "draft.save", capture, owner }),
    { capture, owner: snapshot.auth.origin + "|" + snapshot.auth.subject },
  );
  assert.equal(denied.ok, false);
  assert.equal(
    (await interactive("/api/state")).items.length,
    0,
    "Second account must not acquire the first capture",
  );
  assert.equal(errors.length, 0, "Extension UI runtime errors");
  await writeFile(
    join(output, "verification.json"),
    JSON.stringify(
      {
        passed: true,
        engine: "Chromium MV3",
        server: "isolated local application",
        provider: "synthetic local OpenAI fixture",
        originalCharacters: capture.text.length,
        authoritativeItemId: record.result.item_id,
        idempotentReplay: true,
        sessionKeyOnly: true,
        favoriteModels: 2,
        aiCalls: 1,
        isolatedWorld: true,
        accountSwitchIsolation: true,
        productionTouched: false,
        unverified: [
          "native permission prompt",
          "real Edge/Chrome toolbar and shortcuts",
          "interactive OAuth popup",
          "real provider access",
        ],
        screenshots: [
          "01-compose.png",
          "02-models.png",
          "03-capture-ai.png",
          "04-confirmed.png",
          "05-dark-narrow.png",
        ],
      },
      null,
      2,
    ),
  );
  console.log("Local MV3 verification passed:", output);
} finally {
  await context?.close();
  await new Promise((r) => (fixtureServer ? fixtureServer.close(r) : r()));
  backend.kill();
}
