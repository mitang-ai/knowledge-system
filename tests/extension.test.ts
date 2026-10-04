import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { extractDocument } from "../extension/src/capture/extract";
import {
  composeWrite,
  freshCapture,
  safeURL,
  scrubCapture,
  serviceOrigin,
  validateCapture,
} from "../extension/src/core/capture";
import { CaptureQueue } from "../extension/src/core/queue";
import {
  SystemError,
  CaptureClient,
} from "../extension/src/core/system-client";
import { checkCallback, connectOAuth, pkce } from "../extension/src/core/oauth";
import { material, planAI, runAI } from "../extension/src/core/ai";
import {
  emptyAISettings,
  ownerKey,
  type AuthSession,
  type QueueEntry,
} from "../extension/src/types";
import {
  saveAISettings,
  saveProviderKey,
  providerKey,
  getAISettings,
  putAuth,
  getAuth,
  restrictStorage,
} from "../extension/src/platform/storage";
import { authorizedRequest } from "../extension/src/platform/auth";
import {
  aiAddress,
  permissionPattern,
} from "../extension/src/platform/permissions";
import { discoverModels } from "../src/ai/client";
import type { AIConnection } from "../src/ai/types";

afterEach(() => vi.unstubAllGlobals());
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const auth = (subject = "synthetic-a", grantId = "grant-a"): AuthSession => ({
  origin: "http://127.0.0.1:8789",
  subject,
  grantId,
  accessToken: "synthetic-token-only",
  scopes: ["knowledge:read", "knowledge:write", "proposals:create"],
  spaces: ["personal"],
});
function memoryQueue() {
  let rows: QueueEntry[] = [];
  return {
    get: async () => structuredClone(rows),
    set: async (value: QueueEntry[]) => {
      rows = structuredClone(value);
    },
    rows: () => structuredClone(rows),
  };
}
function browserStorage() {
  const area = () => {
    const values: Record<string, unknown> = {};
    return {
      values,
      get: vi.fn(async (key: string) => ({ [key]: values[key] })),
      set: vi.fn(async (value: Record<string, unknown>) => {
        Object.assign(values, structuredClone(value));
      }),
      remove: vi.fn(async (key: string) => {
        delete values[key];
      }),
      setAccessLevel: vi.fn(async () => {}),
    };
  };
  const chrome = { storage: { local: area(), session: area(), sync: area() } };
  vi.stubGlobal("chrome", chrome);
  return chrome;
}
const page = (html: string, url = "https://example.test/article") =>
  new JSDOM(html, { url }).window.document;

describe("capture contracts and source fidelity", () => {
  it("keeps original words separate from thought and explicitly accepted AI", () => {
    const c = freshCapture("selection", "原文一\n\n原文二", {
      url: "https://example.test/article?utm_source=x&id=42",
      title: "材料",
      coverage: "selection-only",
      warnings: [],
    });
    c.thought = "我的不同观点";
    c.analysis = {
      text: "模型推断",
      requestedModel: "chosen-v1",
      model: "actual-v2",
      complete: true,
      truncated: false,
      task: "insight",
      generatedAt: new Date().toISOString(),
    };
    const body = composeWrite(c);
    expect(body.content).toContain(c.text);
    expect(body.content).toContain("## 我的想法");
    expect(body.content).toContain("## AI 整理");
    expect(body.model_attribution.response_model).toBe("actual-v2");
    expect(c.source?.url).toContain("utm_source");
    expect(body.content).not.toContain("utm_source");
  });
  it("rejects executable/secret fields, invalid URLs and oversized input", () => {
    const c = freshCapture();
    for (const change of [
      { key: "hidden" },
      { action: "run" },
      { schema: "other" },
      { text: "x".repeat(95001) },
      { capturedAt: "invalid" },
      { id: "../path" },
    ])
      expect(() => validateCapture({ ...c, ...change })).toThrow();
    for (const url of [
      "javascript:alert(1)",
      "file:///private",
      "https://user:secret@example.test/",
    ])
      expect(() => safeURL(url)).toThrow();
    expect(() =>
      validateCapture({
        ...c,
        source: {
          url: "https://example.test",
          title: "source",
          coverage: "full-page",
          warnings: [],
        },
      }),
    ).toThrow();
  });
  it("strips tracking and URL credentials but retains useful item identifiers", () => {
    expect(
      safeURL(
        "https://example.test/a?id=42&token=secret&state=private&utm_source=x#access_token=secret",
      ),
    ).toBe("https://example.test/a?id=42");
    expect(safeURL("https://example.test/article#section-2")).toBe(
      "https://example.test/article#section-2",
    );
    expect(safeURL("https://example.test/#/article/42")).toBe(
      "https://example.test/#/article/42",
    );
    expect(safeURL("https://example.test/#/article/42?token=secret")).toBe(
      "https://example.test/",
    );
    expect(serviceOrigin("http://localhost:11434")).toBe(
      "http://localhost:11434",
    );
    for (const v of [
      "http://example.test",
      "https://example.test/api",
      "https://example.test?key=x",
    ])
      expect(() => serviceOrigin(v)).toThrow();
  });
  it("redacts known credentials everywhere in capture metadata and server payload", () => {
    const c = freshCapture("thought", "quoted sentinel-123");
    c.title = "sentinel-123";
    c.thought = "sentinel-123";
    expect(JSON.stringify(scrubCapture(c, ["sentinel-123"]))).not.toContain(
      "sentinel-123",
    );
    expect(
      JSON.stringify(composeWrite(c, "personal", ["sentinel-123"])),
    ).not.toContain("sentinel-123");
  });
  it("uses an inert clone, preserves readable body and safe image links without running code", () => {
    const doc = page(
      `<title>阅读记录</title><nav>导航秘密</nav><article><h1>阅读记录</h1><p>${"这是值得保留的原始观点，包含证据与条件。".repeat(15)}</p><a href="/next?token=secret&id=9">继续阅读</a><img src="/figure.png" alt="示意图"><form><input value="private"><textarea>输入框秘密</textarea></form><script>globalThis.compromised=true</script></article><iframe></iframe>`,
    );
    const before = doc.documentElement.outerHTML,
      c = extractDocument(doc);
    expect(c.source?.coverage).toBe("extracted-article");
    expect(c.text).toContain("原始观点");
    expect(c.text).not.toMatch(/导航秘密|输入框秘密|compromised/);
    expect(c.text).toContain("https://example.test/figure.png");
    expect(c.source?.warnings.join(" ")).toMatch(/图片.*链接/);
    expect(c.source?.warnings.join(" ")).toContain("iframe");
    expect(doc.documentElement.outerHTML).toBe(before);
  });
  it("preserves selected paragraphs and explicitly labels truncated selections", () => {
    const c = extractDocument(
      page("<title>selected</title>"),
      "第一段\n\n第二段",
    );
    expect(c.text).toBe("第一段\n\n第二段");
    expect(c.source?.coverage).toBe("selection-only");
    const long = extractDocument(page(""), "x".repeat(95001));
    expect(long.text.length).toBe(95000);
    expect(long.source?.warnings[0]).toContain("完整归档");
  });
  it("labels unreadable pages as bookmarks instead of fake full-text capture", () => {
    const c = extractDocument(
      page(
        '<title>App</title><form><input value="secret"></form><main>Loading</main>',
      ),
    );
    expect(c.kind).toBe("bookmark");
    expect(c.source?.coverage).toBe("link-only");
    expect(c.source?.warnings[0]).toContain("没有取得");
  });
  it("captures only the matching loaded X post, not other loaded tweets or nonexistent replies", () => {
    const doc = page(
      '<title>X</title><article data-testid="tweet"><a href="/user/status/123">date</a><div data-testid="User-Name">作者</div><div data-testid="tweetText">这条观点值得留下，它还有需要验证的条件。</div></article><article data-testid="tweet"><a href="/user/status/456">date</a><div data-testid="tweetText">其他帖子不应该混入</div></article>',
      "https://x.com/user/status/123",
    );
    const c = extractDocument(doc);
    expect(c.text).toContain("值得留下");
    expect(c.text).not.toContain("其他帖子");
    expect(c.source?.coverage).toBe("loaded-content");
    expect(c.source?.warnings[0]).toContain("未加载");
  });
  it("captures a synthetic loaded Reddit discussion without claiming all replies", () => {
    const c = extractDocument(
      page(
        "<title>Discussion</title><shreddit-post><h1>如何降低记录阻力</h1><p>先留下一句话，而不是强迫自己完成全部分类。</p></shreddit-post><shreddit-comment>这个方法需要后续回顾才能真正形成理解。</shreddit-comment>",
        "https://www.reddit.com/r/PKMS/comments/abc/topic/",
      ),
    );
    expect(c.kind).toBe("thread");
    expect(c.text).toContain("后续回顾");
    expect(c.source?.warnings[0]).toContain("已加载");
  });
  it("refuses a composed record above the server limit rather than dropping sections", () => {
    const c = freshCapture("article", "a".repeat(95000));
    c.thought = "b".repeat(16000);
    expect(() => composeWrite(c)).toThrow("10 万");
    expect(c.thought.length).toBe(16000);
  });
});
describe("durable queue and authority isolation", () => {
  it("persists before sending and retries identical payload and capture ID after a lost acknowledgement", async () => {
    const store = memoryQueue(),
      calls: QueueEntry[] = [],
      seen = new Map<string, object>();
    let now = 1000;
    const send = vi.fn(async (e: QueueEntry) => {
      expect(store.rows()[0].status).toBe("sending");
      calls.push(structuredClone(e));
      const result = seen.get(e.id) || {
        item_id: "one-authoritative-item",
        revision: 1,
      };
      seen.set(e.id, result);
      if (calls.length === 1) throw new SystemError("lost confirmation");
      return result;
    });
    const q = new CaptureQueue(
        store,
        send,
        async () => auth(),
        () => now,
      ),
      c = freshCapture("thought", "网络异常也不能重复记录");
    await q.enqueue(c, composeWrite(c), auth());
    await q.drain();
    expect(store.rows()[0].status).toBe("pending");
    await q.drain();
    expect(send).toHaveBeenCalledTimes(1);
    now = 61001;
    await q.drain();
    expect(store.rows()[0].status).toBe("saved");
    expect(seen.size).toBe(1);
    expect(calls[0].id).toBe(calls[1].id);
    expect(calls[0].payload).toEqual(calls[1].payload);
  });
  it("forbids changing content or authorization behind an existing submission ID", async () => {
    const store = memoryQueue(),
      q = new CaptureQueue(
        store,
        async () => ({ item_id: "x" }),
        async () => auth(),
      ),
      c = freshCapture("thought", "first");
    await q.enqueue(c, composeWrite(c), auth());
    await expect(
      q.enqueue(
        { ...c, text: "changed" },
        composeWrite({ ...c, text: "changed" }),
        auth(),
      ),
    ).rejects.toThrow("不同内容");
    await expect(
      q.enqueue(c, composeWrite(c), auth("synthetic-b")),
    ).rejects.toThrow();
    await expect(
      q.enqueue(c, composeWrite(c), auth("synthetic-a", "new-grant")),
    ).rejects.toThrow();
  });
  it("never drains another account or an old grant using current credentials", async () => {
    const store = memoryQueue(),
      send = vi.fn(async () => ({ item_id: "x" }));
    let current = auth();
    const q = new CaptureQueue(store, send, async () => current),
      c = freshCapture("thought", "isolated");
    await q.enqueue(c, composeWrite(c), current);
    current = auth("synthetic-b", "grant-b");
    await q.drain();
    current = auth("synthetic-a", "replacement");
    await q.drain();
    expect(send).not.toHaveBeenCalled();
    current = auth();
    await q.drain();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("recovers worker interruption with the original identifier", async () => {
    const store = memoryQueue(),
      c = freshCapture("thought", "cold start");
    const q = new CaptureQueue(
      store,
      async () => ({ item_id: "x" }),
      async () => auth(),
    );
    await q.enqueue(c, composeWrite(c), auth());
    const rows = store.rows();
    rows[0].status = "sending";
    await store.set(rows);
    const next = new CaptureQueue(
      store,
      async (e) => {
        expect(e.id).toBe(c.id);
        return { item_id: "x" };
      },
      async () => auth(),
    );
    await next.recover();
    await next.drain();
    expect(store.rows()[0].status).toBe("saved");
  });
  it("marks proposals as awaiting adoption, not saved notes", async () => {
    const a = { ...auth(), scopes: ["knowledge:read", "proposals:create"] },
      store = memoryQueue(),
      q = new CaptureQueue(
        store,
        async () => ({ id: "proposal-id" }),
        async () => a,
      ),
      c = freshCapture("thought", "suggestion");
    await q.enqueue(c, composeWrite(c), a);
    await q.drain();
    expect(store.rows()[0]).toMatchObject({
      status: "proposal",
      mode: "proposal",
    });
  });
  it("does not interpret a schema-valid response without an item ID as success", async () => {
    const store = memoryQueue(),
      q = new CaptureQueue(
        store,
        async () => ({}),
        async () => auth(),
      ),
      c = freshCapture("thought", "unknown");
    await q.enqueue(c, composeWrite(c), auth());
    await q.drain();
    expect(store.rows()[0].status).toBe("pending");
    expect(store.rows()[0].error).toContain("未返回");
  });
  it("stops automatic attempts at five and stops permanent authorization errors immediately", async () => {
    let now = 1;
    const store = memoryQueue(),
      send = vi.fn(async () => {
        throw new SystemError("rate limit", 429);
      }),
      q = new CaptureQueue(
        store,
        send,
        async () => auth(),
        () => now,
      ),
      c = freshCapture("thought", "rate");
    await q.enqueue(c, composeWrite(c), auth());
    for (let i = 0; i < 8; i++) {
      await q.drain();
      now += 3600001;
    }
    expect(send).toHaveBeenCalledTimes(5);
    expect(store.rows()[0].status).toBe("failed");
    const s = memoryQueue(),
      bad = new CaptureQueue(
        s,
        async () => {
          throw new SystemError("denied", 403);
        },
        async () => auth(),
      );
    await bad.enqueue(
      freshCapture("thought", "denied"),
      composeWrite(c),
      auth(),
    );
    await bad.drain();
    expect(s.rows()[0].attempts).toBe(1);
    expect(s.rows()[0].status).toBe("failed");
  });
  it("serializes concurrent drains and rejects writes without the chosen space scope", async () => {
    const store = memoryQueue(),
      send = vi.fn(async () => ({ item_id: "x" })),
      q = new CaptureQueue(store, send, async () => auth()),
      c = freshCapture("thought", "serial");
    await q.enqueue(c, composeWrite(c), auth());
    await Promise.all([q.drain(), q.drain(), q.drain()]);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(
      q.enqueue(
        freshCapture("thought", "forbidden"),
        composeWrite(c, "another-space"),
        auth(),
      ),
    ).rejects.toThrow("空间");
  });
});
describe("credentials, provider transport and OAuth", () => {
  it("uses session keys by default, local only on opt-in, no sync and no keys in provider profiles", async () => {
    const b = browserStorage(),
      owner = ownerKey(auth());
    await restrictStorage();
    expect(b.storage.local.setAccessLevel).toHaveBeenCalledWith({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    await saveProviderKey(owner, "provider", "synthetic-ai-key", false);
    expect(JSON.stringify(b.storage.local.values)).not.toContain(
      "synthetic-ai-key",
    );
    expect(await providerKey(owner, "provider")).toBe("synthetic-ai-key");
    expect(await providerKey(ownerKey(auth("other")), "provider")).toBe("");
    await saveProviderKey(owner, "provider", "remembered-key", true);
    expect(JSON.stringify(b.storage.session.values)).not.toContain(
      "remembered-key",
    );
    const s = emptyAISettings();
    s.providers.push({
      id: "provider",
      name: "Test",
      protocol: "openai",
      baseUrl: "https://ai.example.test/v1",
      models: [],
      remember: true,
      key: "must-not-project",
    } as never);
    await saveAISettings(owner, s);
    expect(JSON.stringify(await getAISettings(owner))).not.toContain(
      "must-not-project",
    );
    expect(b.storage.sync.set).not.toHaveBeenCalled();
  });
  it("only allows explicitly opted-in loopback OpenAI without a Key", async () => {
    vi.stubGlobal("location", { origin: "chrome-extension://fixture" });
    const fetcher = vi.fn(async () =>
      json({ data: [{ id: "local-a" }, { id: "local-b" }] }),
    );
    vi.stubGlobal("fetch", fetcher);
    const c: AIConnection = {
      id: "local",
      name: "Local",
      protocol: "openai",
      baseUrl: "http://localhost:11434/v1",
      key: "",
      remember: false,
      models: [],
      allowUnauthenticated: true,
    };
    expect((await discoverModels(c, new AbortController().signal)).length).toBe(
      2,
    );
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBeUndefined();
    for (const change of [
      { allowUnauthenticated: false },
      { baseUrl: "https://ai.example.test/v1" },
      { protocol: "anthropic" },
    ])
      await expect(
        discoverModels(
          { ...c, ...change } as AIConnection,
          new AbortController().signal,
        ),
      ).rejects.toThrow("Key");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("pins hosts to user configured endpoints and prohibits the knowledge system as AI proxy", () => {
    expect(permissionPattern("http://localhost:11434/v1")).toBe(
      "http://localhost/*",
    );
    expect(
      aiAddress(
        "https://ai.example.test/custom/v1",
        "https://core.example.test",
      ),
    ).toBe("https://ai.example.test/custom/v1");
    expect(() =>
      aiAddress("https://core.example.test/ai", "https://core.example.test"),
    ).toThrow();
    expect(() => permissionPattern("http://remote.example.test/v1")).toThrow();
  });
  it("validates PKCE and binds the callback to redirect, path and state", async () => {
    const pair = await pkce();
    expect(pair.verifier.length).toBe(43);
    expect(pair.challenge.length).toBe(43);
    expect(pair.challenge).not.toBe(pair.verifier);
    const redirect = "https://extension.chromiumapp.org/sediment";
    expect(
      checkCallback(redirect + "?state=expected&code=c", redirect, "expected"),
    ).toBe("c");
    for (const value of [
      redirect + "?state=wrong&code=c",
      "https://other.test/sediment?state=expected&code=c",
      redirect + "/wrong?state=expected&code=c",
      redirect + "?state=expected&error=denied",
    ])
      expect(() => checkCallback(value, redirect, "expected")).toThrow();
  });
  it("rejects foreign OAuth metadata before sending client registration or credentials", async () => {
    const fetcher = vi.fn(async () =>
      json({
        issuer: "https://core.example.test/",
        authorization_endpoint: "https://foreign.example.test/oauth/authorize",
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      connectOAuth(
        "https://core.example.test",
        "urn:resource",
        "https://extension.chromiumapp.org/sediment",
        async () => "",
      ),
    ).rejects.toThrow("端点");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not erase a newly connected account when an old refresh completes late", async () => {
    browserStorage();
    const old = {
      ...auth(),
      refreshToken: "synthetic-refresh",
      clientId: "client",
      resource: "urn:test",
      expiresAt: 1,
    };
    await putAuth(old);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await putAuth(auth("synthetic-b", "grant-b"));
        return json({
          access_token: "rotated-test",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        });
      }),
    );
    await expect(
      authorizedRequest("/api/v1/capabilities", undefined, undefined, old),
    ).rejects.toThrow("切换");
    expect((await getAuth())?.subject).toBe("synthetic-b");
  });
  it("portable SDK uses bearer-only API with stable idempotency and no cookies", async () => {
    const fetcher = vi.fn(async () =>
        json({
          schema_version: "sediment.api.v1",
          item_id: "authoritative-id",
        }),
      ),
      client = new CaptureClient(
        "https://core.example.test",
        "synthetic-token",
        fetcher,
      ),
      c = freshCapture("thought", "portable");
    await client.write(composeWrite(c), "clip-v1:" + c.id);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("https://core.example.test/api/v1/write");
    expect(options.credentials).toBe("omit");
    expect(options.headers["Idempotency-Key"]).toBe("clip-v1:" + c.id);
    expect(options.redirect).toBe("error");
  });
});
describe("explicit AI costs and source boundary", () => {
  it("polishes personal words only, never mixing article content into personal expression", () => {
    const c = freshCapture("article", "ARTICLE ONLY");
    c.thought = "MY THOUGHT";
    expect(material(c, "polish")).toBe("MY THOUGHT");
    expect(material(c, "summary")).toContain("ARTICLE ONLY");
  });
  it("discloses exact split count and refuses long material before any provider call without confirmation", async () => {
    const c = freshCapture("article", "a".repeat(36001));
    expect(planAI(c.text).requests).toBe(4);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      runAI({} as AIConnection, "chosen", c, "summary", false, {
        signal: new AbortController().signal,
        maxTokens: 512,
        onDelta: () => {},
        onProgress: () => {},
      }),
    ).rejects.toThrow("4 次");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
