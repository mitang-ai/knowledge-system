import {
  freshCapture,
  composeWrite,
  scrubCapture,
  safeURL,
  serviceOrigin,
  validateCapture,
} from "./core/capture";
import { CaptureQueue } from "./core/queue";
import { connectToken, revokeOAuth } from "./core/oauth";
import { authorizedRequest } from "./platform/auth";
import {
  getAuth,
  putAuth,
  getQueue,
  putQueue,
  getDrafts,
  putDrafts,
  knownSecrets,
  restrictStorage,
} from "./platform/storage";
import { ownerKey } from "./types";
import type {
  AuthSession,
  Capabilities,
  CaptureEnvelope,
  PublicSession,
  QueueEntry,
  WriteResult,
} from "./types";
import type {} from "./capture/entry";

const queue = new CaptureQueue(
  {
    get: getQueue,
    set: async (rows) => {
      const confirmed = rows
        .filter((e) => ["saved", "proposal"].includes(e.status))
        .slice(-20);
      const retained = rows
        .filter((e) => !["saved", "proposal"].includes(e.status))
        .concat(confirmed);
      if (new TextEncoder().encode(JSON.stringify(retained)).length > 6500000)
        throw new Error(
          "本机待同步存储空间不足，请先处理或导出草稿；未报告入库成功。",
        );
      await putQueue(retained);
      await updateBadge(retained);
    },
  },
  (entry, auth) =>
    authorizedRequest<WriteResult>(
      entry.mode === "write" ? "/api/v1/write" : "/api/v1/proposals",
      entry.payload,
      "clip-v1:" + entry.id,
      auth,
    ),
  getAuth,
);
let draftMutation: Promise<unknown> = Promise.resolve();
const changeDrafts = <T>(
  fn: (rows: Awaited<ReturnType<typeof getDrafts>>) => T | Promise<T>,
): Promise<T> => {
  const pending = draftMutation.then(async () => {
    const rows = await getDrafts();
    const result = await fn(rows);
    if (new TextEncoder().encode(JSON.stringify(rows)).length > 2500000)
      throw new Error(
        "设备草稿空间不足，请先导出旧草稿。当前内容仍在编辑器中。",
      );
    await putDrafts(rows);
    return result;
  });
  draftMutation = pending.catch(() => {});
  return pending;
};
function publicAuth(auth: AuthSession | null): PublicSession | null {
  if (!auth) return null;
  const {
    accessToken: _access,
    refreshToken: _refresh,
    clientId: _client,
    ...publicData
  } = auth;
  return publicData;
}
async function updateBadge(rows: QueueEntry[]) {
  const auth = await getAuth();
  const local = rows.filter((r) => r.ownerKey === ownerKey(auth));
  const pending = local.filter(
    (e) => !["saved", "proposal"].includes(e.status),
  ).length;
  await chrome.action.setBadgeBackgroundColor({ color: "#242424" });
  await chrome.action.setBadgeText({ text: pending ? String(pending) : "" });
}
async function saveDraft(c: CaptureEnvelope, expectedOwner?: unknown) {
  const key = ownerKey(await getAuth());
  if (expectedOwner !== undefined && expectedOwner !== key)
    throw new Error("账号已经切换，旧编辑器的草稿没有写入新账号。");
  const capture = scrubCapture(c, await knownSecrets(key));
  await changeDrafts((rows) => {
    const i = rows.findIndex((d) => d.id === capture.id && d.ownerKey === key);
    const row = {
      id: capture.id,
      ownerKey: key,
      capture,
      updatedAt: new Date().toISOString(),
    };
    if (i < 0) rows.push(row);
    else rows[i] = row;
  });
}
async function enqueue(
  c: CaptureEnvelope,
  space = "personal",
  expectedOwner?: unknown,
) {
  await boot;
  const auth = await getAuth();
  if (expectedOwner !== undefined && expectedOwner !== ownerKey(auth))
    throw new Error("账号已经切换，请核对当前账号后再提交。");
  if (!auth) {
    await saveDraft(c);
    throw new Error(
      "尚未连接系统，已保存为设备草稿。连接后请确认沉淀到该账号。",
    );
  }
  const credentials = await knownSecrets(ownerKey(auth));
  // Local capture metadata is also scrubbed, not only its rendered server payload.
  const capture = scrubCapture(c, credentials),
    payload = composeWrite(capture, space, credentials);
  const row = await queue.enqueue(capture, payload, auth);
  await changeDrafts((rows) => {
    const i = rows.findIndex(
      (d) =>
        d.id === capture.id &&
        (d.ownerKey === ownerKey(auth) || d.ownerKey === "device"),
    );
    if (i >= 0) rows.splice(i, 1);
  });
  void queue.drain().catch(() => {});
  return row;
}
async function captureTab(tabId?: number, preferSelection = false) {
  const tab = tabId
    ? await chrome.tabs.get(tabId)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id || !tab.url || !/^https?:/.test(tab.url))
    throw new Error(
      "这个标签页不能直接读取。请在普通网页点击工具栏图标或使用快捷键；PDF 可选择复制文字后粘贴。",
    );
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["capture.js"],
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (selection: boolean) => globalThis.__sedimentCaptureV1?.(selection),
      args: [preferSelection],
    });
    return validateCapture(results[0]?.result);
  } catch {
    throw new Error(
      "尚未获得该页读取权限。请点击工具栏插件图标、右键或按 Alt+Shift+S；不会后台读取所有标签页。",
    );
  }
}
function openPanel(tab?: chrome.tabs.Tab) {
  // Call synchronously in the original action/command/menu gesture, before awaits.
  if (tab?.windowId !== undefined)
    void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
}
async function stage(
  c: CaptureEnvelope,
  quick = false,
  windowId?: number,
  expectedOwner?: string,
) {
  const id = windowId ?? (await chrome.windows.getLastFocused()).id;
  const owner = ownerKey(await getAuth());
  if (expectedOwner !== undefined && expectedOwner !== owner)
    throw new Error("读取期间账号发生切换，没有将旧捕获关联到新账号。");
  await chrome.storage.session.set({
    ["pending-capture:v1:" + id]: { capture: c, owner, quick, at: Date.now() },
  });
}
async function captureError(error: unknown, windowId?: number) {
  const id = windowId ?? (await chrome.windows.getLastFocused()).id;
  await chrome.storage.session.set({
    ["capture-error:v1:" + id]:
      error instanceof Error ? error.message : "读取未完成。",
  });
}
async function gestureCapture(tab?: chrome.tabs.Tab, save = false) {
  try {
    const owner = ownerKey(await getAuth());
    const c = await captureTab(tab?.id, save);
    if (save) {
      await enqueue(c, "personal", owner);
      await stage(freshCapture(), false, tab?.windowId, owner);
    } else await stage(c, false, tab?.windowId, owner);
  } catch (error) {
    await captureError(error, tab?.windowId);
  }
}
chrome.action.onClicked.addListener((tab) => {
  openPanel(tab);
  void gestureCapture(tab);
});
chrome.commands.onCommand.addListener((command, tab) => {
  openPanel(tab);
  if (command === "quick-note") void stage(freshCapture(), true, tab?.windowId);
  else if (command === "save-page") void gestureCapture(tab, true);
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  openPanel(tab);
  void (async () => {
    try {
      const owner = ownerKey(await getAuth());
      if (info.menuItemId === "sediment-selection" && info.selectionText) {
        const source = {
          url: safeURL(info.frameUrl || info.pageUrl || tab?.url || ""),
          title: (tab?.title || "网页摘录").slice(0, 240),
          coverage: "selection-only" as const,
          warnings:
            info.selectionText.length > 95000
              ? ["仅保留前 95,000 字符，选区未完整归档。"]
              : [],
        };
        const c = freshCapture(
          "selection",
          info.selectionText.slice(0, 95000),
          source,
        );
        await enqueue(c, "personal", owner);
        await stage(freshCapture(), false, tab?.windowId, owner);
      } else if (info.menuItemId === "sediment-link" && info.linkUrl) {
        const url = safeURL(info.linkUrl);
        const c = freshCapture("bookmark", "", {
          url,
          title: url.slice(0, 240),
          coverage: "link-only",
          warnings: [],
        });
        await enqueue(c, "personal", owner);
        await stage(freshCapture(), false, tab?.windowId, owner);
      } else await gestureCapture(tab, true);
    } catch (error) {
      await captureError(error, tab?.windowId);
    }
  })();
});
async function initialize() {
  await boot;
  await chrome.alarms.create("sediment-sync", { periodInMinutes: 1 });
  await updateBadge(await getQueue());
}
chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: "sediment-selection",
      title: "沉淀选中的文字",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "sediment-page",
      title: "一键沉淀当前网页",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "sediment-link",
      title: "沉淀这个链接",
      contexts: ["link"],
    });
    await initialize();
  })();
});
chrome.runtime.onStartup.addListener(() => {
  void initialize().then(() => queue.drain());
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sediment-sync")
    void boot.then(() => queue.drain()).catch(() => {});
});

async function handle(m: Record<string, unknown>) {
  await boot;
  const auth = await getAuth(),
    key = ownerKey(auth);
  switch (m.type) {
    case "state":
      return {
        auth: publicAuth(auth),
        queue: (await getQueue()).filter((e) => e.ownerKey === key),
        drafts: (await getDrafts()).filter(
          (d) => d.ownerKey === key || d.ownerKey === "device",
        ),
      };
    case "capture.page": {
      const c = await captureTab(undefined, !!m.selection);
      await stage(c, false, undefined, key);
      return c;
    }
    case "draft.save":
      await saveDraft(validateCapture(m.capture), m.owner);
      return {};
    case "draft.remove":
      await changeDrafts((rows) => {
        const i = rows.findIndex(
          (d) =>
            d.id === m.id && (d.ownerKey === key || d.ownerKey === "device"),
        );
        if (i >= 0) rows.splice(i, 1);
      });
      return {};
    case "queue.enqueue":
      return enqueue(
        validateCapture(m.capture),
        typeof m.space === "string" ? m.space : "personal",
        m.owner,
      );
    case "queue.retry":
    case "queue.remove": {
      const row = (await getQueue()).find(
        (r) => r.id === m.id && r.ownerKey === key,
      );
      if (!row) throw new Error("这条记录不属于当前账号。");
      if (m.type === "queue.retry") {
        if (row.grantId !== auth?.grantId)
          throw new Error(
            "原授权已更换。请先在系统核对是否入库，不能用新授权自动重发旧提交。",
          );
        await queue.retry(row.id);
      } else await queue.remove(row.id);
      return {};
    }
    case "auth.token": {
      const origin = serviceOrigin(String(m.origin || ""));
      const next = await connectToken(origin, String(m.token || ""));
      await putAuth(next);
      return publicAuth(next);
    }
    case "auth.install": {
      const provided = m.auth as AuthSession;
      if (!provided || typeof provided.accessToken !== "string")
        throw new Error("授权格式无效。");
      const checked = await connectToken(provided.origin, provided.accessToken);
      if (
        checked.grantId !== provided.grantId ||
        checked.subject !== provided.subject
      )
        throw new Error("授权身份不匹配。");
      await putAuth({
        ...checked,
        clientId: provided.clientId,
        resource: provided.resource,
        refreshToken: provided.refreshToken,
        expiresAt: provided.expiresAt,
      });
      return publicAuth(checked);
    }
    case "auth.disconnect": {
      let revoked = false;
      if (auth)
        try {
          revoked = await revokeOAuth(auth);
        } catch {
          /* Report separately from local disconnect. */
        }
      await putAuth(null);
      return { revoked };
    }
    case "system.capabilities":
      return authorizedRequest<Capabilities>("/api/v1/capabilities");
    default:
      throw new Error("不支持这个插件操作。");
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Content scripts and ordinary websites cannot invoke secret-bearing operations.
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL("panel.html"))
  )
    return false;
  if (!message || typeof message !== "object") return false;
  void handle(message)
    .then((data) => reply({ ok: true, data }))
    .catch((error) =>
      reply({
        ok: false,
        error: error instanceof Error ? error.message : "操作未完成。",
      }),
    );
  return true;
});
// Runs on every MV3 cold start, including idle-worker recovery (not only browser startup).
const boot = restrictStorage().then(() => queue.recover());
