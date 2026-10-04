import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  ArrowDownToLine,
  Check,
  ChevronDown,
  FileText,
  Globe2,
  Lightbulb,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { BrandMark } from "../../../src/Brand";
import { safeAIError } from "../../../src/ai/client";
import { taskNames, material, planAI, runAI } from "../core/ai";
import {
  coverageNames,
  freshCapture,
  scrubCapture,
  validateCapture,
} from "../core/capture";
import { aiAddress, allowHost } from "../platform/permissions";
import { getAISettings, knownSecrets, providerKey } from "../platform/storage";
import { message } from "../platform/messages";
import { emptyAISettings, ownerKey, DEFAULT_ORIGIN } from "../types";
import type {
  AISettings,
  AITask,
  CaptureEnvelope,
  Draft,
  PublicSession,
  QueueEntry,
} from "../types";
import { Settings } from "./Settings";
import { exportCapture, formatTime, openSystem } from "./utils";
import "./styles.css";

interface Snapshot {
  auth: PublicSession | null;
  queue: QueueEntry[];
  drafts: Draft[];
}
function Panel() {
  const [state, setState] = useState<Snapshot>({
      auth: null,
      queue: [],
      drafts: [],
    }),
    [ready, setReady] = useState(false),
    [view, setView] = useState<"compose" | "drafts" | "settings">(
      location.hash === "#settings" ? "settings" : "compose",
    ),
    [capture, setCapture] = useState<CaptureEnvelope>(() => freshCapture()),
    [settings, setSettings] = useState<AISettings>(emptyAISettings),
    [toast, setToast] = useState(""),
    [draftStatus, setDraftStatus] = useState(""),
    [saving, setSaving] = useState(false),
    [showOriginal, setShowOriginal] = useState(false),
    [showAI, setShowAI] = useState(false),
    [task, setTask] = useState<AITask>("summary"),
    [model, setModel] = useState(""),
    [analysis, setAnalysis] = useState<CaptureEnvelope["analysis"]>(),
    [aiText, setAIText] = useState(""),
    [aiBusy, setAIBusy] = useState(false),
    [aiProgress, setAIProgress] = useState(""),
    [allowSplit, setAllowSplit] = useState(false),
    [includeAI, setIncludeAI] = useState(false),
    [space, setSpace] = useState("personal");
  const captureRef = useRef(capture),
    stateRef = useRef(state),
    analysisRef = useRef(analysis),
    seenPending = useRef(0),
    scope = useRef<string | null>(null),
    controller = useRef<AbortController | null>(null),
    fileInput = useRef<HTMLInputElement>(null),
    editor = useRef<HTMLTextAreaElement>(null),
    noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    refreshSerial = useRef<Promise<void>>(Promise.resolve()),
    submitted = useRef(new Set<string>());
  captureRef.current = capture;
  stateRef.current = state;
  analysisRef.current = analysis;
  const key = ownerKey(state.auth);
  const notify = useCallback((text: string) => {
    setToast(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setToast(""), 8500);
  }, []);
  const restore = (next: CaptureEnvelope) => {
    controller.current?.abort();
    captureRef.current = next;
    analysisRef.current = next.analysis;
    setCapture(next);
    setAnalysis(next.analysis);
    setAIText(next.analysis?.text || "");
    setIncludeAI(false);
    setAllowSplit(false);
    setAIBusy(false);
    setAIProgress("");
    setShowAI(!!next.analysis);
    setDraftStatus("");
    setView("compose");
  };
  const refresh = useCallback(() => {
    const run = async () => {
      try {
        const next = await message<Snapshot>("state");
        setState(next);
        setReady(true);
        const owner = ownerKey(next.auth),
          changed = scope.current !== null && scope.current !== owner;
        if (scope.current !== owner) {
          if (scope.current !== null) {
            controller.current?.abort();
            const blank = freshCapture();
            captureRef.current = blank;
            analysisRef.current = undefined;
            setCapture(blank);
            setAnalysis(undefined);
            setAIText("");
            setIncludeAI(false);
            setAIBusy(false);
            setDraftStatus("");
            setSpace("personal");
          }
          scope.current = owner;
          setSettings(await getAISettings(owner));
        }
        const windowId = (await chrome.windows.getCurrent()).id,
          pendingKey = "pending-capture:v1:" + windowId,
          errorKey = "capture-error:v1:" + windowId;
        const session = await chrome.storage.session.get([
          pendingKey,
          errorKey,
        ]);
        const pending = session[pendingKey] as
          | {
              capture: CaptureEnvelope;
              owner: string;
              at: number;
              quick?: boolean;
            }
          | undefined;
        if (
          pending &&
          pending.owner === owner &&
          pending.at > seenPending.current &&
          Date.now() - pending.at < 30 * 60 * 1000
        ) {
          seenPending.current = pending.at;
          // Preserve an existing composer before replacing it with another gesture capture.
          const current = captureRef.current;
          if (
            !changed &&
            !submitted.current.has(current.id) &&
            current.id !== pending.capture.id &&
            (current.text.trim() || current.thought.trim())
          )
            await message("draft.save", {
              owner,
              capture: { ...current, analysis: analysisRef.current },
            });
          restore(validateCapture(pending.capture));
          if (pending.quick) setTimeout(() => editor.current?.focus(), 100);
        }
        if (session[errorKey]) {
          notify(String(session[errorKey]));
          await chrome.storage.session.remove(errorKey);
        }
      } catch (e) {
        notify((e as Error).message);
      }
    };
    refreshSerial.current = refreshSerial.current.then(run, run);
    return refreshSerial.current;
  }, [notify]);
  useEffect(() => {
    void refresh();
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (
        (area === "local" &&
          (changes["auth:v1"] ||
            changes["queue:v1"] ||
            changes["drafts:v1"])) ||
        (area === "session" &&
          Object.keys(changes).some(
            (k) =>
              k.startsWith("pending-capture:v1:") ||
              k.startsWith("capture-error:v1:"),
          ))
      )
        void refresh();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      chrome.storage.onChanged.removeListener(onChanged);
      controller.current?.abort();
      clearTimeout(noticeTimer.current);
    };
  }, [refresh]);
  useEffect(() => {
    if (
      !ready ||
      (!capture.text.trim() && !capture.thought.trim() && !capture.source)
    )
      return;
    const id = capture.id;
    if (submitted.current.has(id)) return;
    setDraftStatus("正在保存草稿…");
    const timer = setTimeout(() => {
      if (submitted.current.has(id)) return;
      void message("draft.save", {
        owner: key,
        capture: { ...capture, analysis },
      })
        .then(() => {
          if (captureRef.current.id === id) setDraftStatus("草稿已保存在本机");
        })
        .catch((e) => notify(e.message));
    }, 450);
    return () => clearTimeout(timer);
  }, [capture, analysis, ready, key, notify]);
  useEffect(() => {
    const close = () => {
      const c = captureRef.current;
      if (
        !submitted.current.has(c.id) &&
        (c.text.trim() || c.thought.trim() || c.source)
      )
        void message("draft.save", {
          owner: ownerKey(stateRef.current.auth),
          capture: { ...c, analysis: analysisRef.current },
        }).catch(() => {});
    };
    window.addEventListener("pagehide", close);
    return () => window.removeEventListener("pagehide", close);
  }, []);
  const enabled = settings.providers.flatMap((p) =>
    p.models
      .filter((m) => m.enabled)
      .map((m) => ({
        id: p.id + "::" + m.id,
        provider: p,
        model: m,
        label: p.name + " · " + m.name,
      })),
  );
  useEffect(() => {
    const wanted = settings.defaultModels[task];
    setModel(
      wanted && enabled.some((m) => m.id === wanted)
        ? wanted
        : enabled[0]?.id || "",
    );
  }, [task, settings]);
  const flushDraft = async () => {
    const c = captureRef.current;
    if (
      !submitted.current.has(c.id) &&
      (c.text.trim() || c.thought.trim() || c.source)
    )
      await message("draft.save", {
        owner: key,
        capture: { ...c, analysis: analysisRef.current },
      });
  };
  const change = (fields: Partial<CaptureEnvelope>) => {
    if (
      fields.text !== undefined ||
      fields.thought !== undefined ||
      fields.source !== undefined
    ) {
      controller.current?.abort();
      setAnalysis(undefined);
      analysisRef.current = undefined;
      setAIText("");
      setIncludeAI(false);
      setAIBusy(false);
    }
    setCapture((c) => ({ ...c, ...fields }));
  };
  const startNew = async () => {
    try {
      await flushDraft();
      restore(freshCapture());
      setTimeout(() => editor.current?.focus(), 0);
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const readPage = async () => {
    setSaving(true);
    try {
      await flushDraft();
      const next = await message<CaptureEnvelope>("capture.page");
      restore(next);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const submit = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const next = { ...capture, analysis: includeAI ? analysis : undefined };
      if (!state.auth) {
        await message("draft.save", {
          owner: key,
          capture: { ...capture, analysis },
        });
        notify("已留在本机。连接知识空间后，再确认沉淀到你的账号。");
        setView("drafts");
        return;
      }
      submitted.current.add(capture.id);
      try {
        await message<QueueEntry>("queue.enqueue", {
          owner: key,
          capture: next,
          space,
        });
      } catch (e) {
        submitted.current.delete(capture.id);
        throw e;
      }
      notify(
        state.auth.scopes.includes("knowledge:write")
          ? "已进入同步队列，收到系统记录标识后才显示已沉淀。"
          : "已进入同步队列；这份授权只提交待采纳，请在系统确认收录。",
      );
      restore(freshCapture());
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [capture, analysis, includeAI, state.auth, space, saving, notify]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (view === "compose" && (e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void submit();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [view, submit]);
  const generate = async () => {
    const selected = enabled.find((m) => m.id === model);
    if (!selected) {
      notify("先在设置里添加 AI 服务并勾选常用模型。");
      return;
    }
    const c = { ...capture },
      initialOwner = key,
      id = c.id;
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    setAIBusy(true);
    setAIText("");
    setAnalysis(undefined);
    setIncludeAI(false);
    const current = () =>
      controller.current === abort &&
      captureRef.current.id === id &&
      ownerKey(stateRef.current.auth) === initialOwner;
    try {
      const baseUrl = aiAddress(
        selected.provider.baseUrl,
        state.auth?.origin || DEFAULT_ORIGIN,
      );
      await allowHost(baseUrl);
      const p = {
        ...selected.provider,
        baseUrl,
        key: await providerKey(key, selected.provider.id),
        allowUnauthenticated: !!selected.provider.localUnauthenticated,
      };
      const secrets = await knownSecrets(key),
        safe = scrubCapture(c, secrets);
      const result = await runAI(p, selected.model.id, safe, task, allowSplit, {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(180000)]),
        maxTokens: settings.maxTokens,
        onDelta: (text) => {
          if (current()) setAIText(text);
        },
        onProgress: (at, total) => {
          if (current()) setAIProgress(`${at} / ${total} 次调用`);
        },
      });
      if (current())
        setAnalysis({ ...result, task, generatedAt: new Date().toISOString() });
    } catch (e) {
      if (current())
        notify(
          e instanceof Error && e.name !== "AIError" && e.name !== "AbortError"
            ? e.message
            : safeAIError(e),
        );
    } finally {
      if (current()) {
        setAIBusy(false);
        controller.current = null;
      }
    }
  };
  const exportCurrent = async (c: CaptureEnvelope) => {
    try {
      exportCapture(scrubCapture(c, await knownSecrets(key)));
      notify("已导出捕获包，不包含系统授权或 AI 配置。");
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const importFile = async (file: File) => {
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("捕获包不能超过 2 MB。");
      const value = validateCapture(JSON.parse(await file.text()));
      await flushDraft();
      restore({ ...value, id: crypto.randomUUID() });
      notify("已作为新草稿打开。请核对来源和文字，尚未上传系统。");
    } catch (e) {
      notify((e as Error).message);
    }
  };
  let calls = 1;
  try {
    calls = planAI(material(capture, task)).requests;
  } catch {
    /* The send action reports an explicit error for empty or excessive material. */
  }
  const pending = state.queue.filter(
    (e) => !["saved", "proposal"].includes(e.status),
  );
  const statusLabel = (q: QueueEntry) =>
    ({
      pending: "等待同步",
      sending: "等待系统确认",
      failed: "需要处理",
      saved: "已沉淀",
      proposal: "待系统采纳",
    })[q.status];

  return (
    <div className="panel-shell">
      <header className="brand-header">
        <div className="brand-lockup">
          <BrandMark />
          <span>
            沉淀<small>随手记</small>
          </span>
        </div>
        <div className="row">
          <button
            className="icon-button"
            aria-label="新建想法"
            onClick={() => void startNew()}
          >
            <Plus size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="打开插件设置"
            onClick={() => setView("settings")}
          >
            <Settings2 size={17} />
          </button>
        </div>
      </header>
      {view === "settings" ? (
        <Settings
          key={key}
          auth={state.auth}
          owner={key}
          settings={settings}
          onSettings={setSettings}
          onBack={() => setView("compose")}
          notify={notify}
          beforeSwitch={flushDraft}
        />
      ) : (
        <>
          <div className="account-strip">
            <button onClick={() => setView("settings")}>
              <span
                className={state.auth ? "connected-dot" : "disconnected-dot"}
              />
              {state.auth
                ? new URL(state.auth.origin).hostname
                : "连接你的知识空间"}
              <ArrowUpRight size={12} />
            </button>
            <span>
              {pending.length
                ? `${pending.length} 条待同步`
                : state.auth
                  ? "已连接"
                  : "仅此设备"}
            </span>
          </div>
          <nav className="tabs main-tabs" aria-label="插件页面">
            <button
              aria-selected={view === "compose"}
              onClick={() => setView("compose")}
            >
              <Lightbulb size={14} />
              随手记
            </button>
            <button
              aria-selected={false}
              onClick={() => void readPage()}
              disabled={saving}
            >
              <Globe2 size={14} />
              读取网页
            </button>
            <button
              aria-selected={view === "drafts"}
              onClick={() => setView("drafts")}
            >
              <FileText size={14} />
              草稿
              {state.drafts.length > 0 && (
                <span className="count">{state.drafts.length}</span>
              )}
            </button>
          </nav>
          {view === "compose" ? (
            <main className="composer">
              <div className="eyebrow">
                {capture.source ? "从阅读，到自己的理解" : "留给未来的自己"}
              </div>
              <h1>
                {capture.source ? "这一刻，有什么启发？" : "此刻，你在想什么？"}
              </h1>
              <p className="muted lead">
                {capture.source
                  ? "原文已经留好。把你自己的思考也写下来。"
                  : "一句话也值得记下来。不用先想好标题和分类。"}
              </p>
              {capture.source && (
                <div className="source-card">
                  <div className="row">
                    <Globe2 size={15} />
                    <strong>{capture.source.title}</strong>
                    <button
                      className="icon-button"
                      aria-label="移除网页来源"
                      onClick={() => {
                        if (confirm("移除当前网页材料？你的想法会保留。")) {
                          change({
                            kind: "thought",
                            text: "",
                            source: undefined,
                            title: "",
                          });
                          setAnalysis(undefined);
                          setAIText("");
                          setIncludeAI(false);
                        }
                      }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <small>
                    {new URL(capture.source.url).hostname} ·{" "}
                    {capture.text.length.toLocaleString()} 字符 ·{" "}
                    {coverageNames[capture.source.coverage]}
                  </small>
                  <button
                    className="text-button small"
                    onClick={() => setShowOriginal(!showOriginal)}
                  >
                    {showOriginal ? "收起原文" : "核对原文"}
                    <ChevronDown size={12} />
                  </button>
                  {showOriginal && (
                    <pre className="original-preview">
                      {capture.text || "没有取得正文，仅保留链接。"}
                    </pre>
                  )}
                  {capture.source.warnings.map((w) => (
                    <p className="warning" key={w}>
                      {w}
                    </p>
                  ))}
                </div>
              )}
              <textarea
                ref={editor}
                className="thought-editor"
                aria-label="我的想法"
                placeholder={
                  capture.source
                    ? "它让你想到什么？\n哪里值得认同，哪里还需要验证？"
                    : "比如：今天终于想明白了…\n\n不用写得完整，先留下它。"
                }
                value={capture.source ? capture.thought : capture.text}
                onChange={(e) =>
                  change(
                    capture.source
                      ? { thought: e.target.value }
                      : { text: e.target.value },
                  )
                }
                maxLength={capture.source ? 16000 : 95000}
              />
              <details className="optional-details">
                <summary>标题与空间（可选）</summary>
                <label className="field">
                  标题
                  <input
                    value={capture.title}
                    maxLength={240}
                    onChange={(e) => change({ title: e.target.value })}
                    placeholder="留空也能沉淀"
                  />
                </label>
                {state.auth && (
                  <label className="field">
                    沉淀到
                    <select
                      value={space}
                      onChange={(e) => setSpace(e.target.value)}
                    >
                      {state.auth.spaces.map((s) => (
                        <option value={s} key={s}>
                          {s === "personal"
                            ? "我的个人空间"
                            : "已授权空间 " + s.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </details>
              <div className="ai-entry">
                <button
                  className="text-button"
                  onClick={() => setShowAI(!showAI)}
                >
                  <Sparkles size={15} />
                  {showAI ? "收起 AI 整理" : "想借助自己的 AI？"}
                </button>
                <span>可选 · 不自动调用</span>
              </div>
              {showAI && (
                <section className="ai-workbench">
                  <div className="two-col">
                    <label className="field">
                      整理任务
                      <select
                        value={task}
                        disabled={aiBusy}
                        onChange={(e) => setTask(e.target.value as AITask)}
                      >
                        {Object.entries(taskNames).map(([id, label]) => (
                          <option key={id} value={id}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      这次使用
                      <select
                        value={model}
                        disabled={aiBusy}
                        onChange={(e) => setModel(e.target.value)}
                      >
                        <option value="">选择一个模型</option>
                        {enabled.map((m) => (
                          <option value={m.id} key={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {enabled.length === 0 && (
                    <button
                      className="secondary full"
                      onClick={() => setView("settings")}
                    >
                      添加自己的服务和常用模型
                    </button>
                  )}
                  <p className="helper">
                    只发送当前记录的
                    {task === "polish" ? "个人文字" : "正文与想法"}
                    ，不发送其他标签页或全库。来源中的链接不会另行打开。
                  </p>
                  {calls > 1 && (
                    <label className="check-line warning">
                      <input
                        type="checkbox"
                        checked={allowSplit}
                        onChange={(e) => setAllowSplit(e.target.checked)}
                      />
                      允许 {calls} 次分段 / 合并调用（可能计费，不会截断原文）
                    </label>
                  )}
                  <div className="row spread">
                    <button
                      className="secondary"
                      disabled={aiBusy || !model}
                      onClick={() => void generate()}
                    >
                      <Sparkles size={14} />
                      开始整理
                    </button>
                    {aiBusy ? (
                      <button
                        className="text-button"
                        onClick={() => controller.current?.abort()}
                      >
                        <Square size={12} />
                        停止
                      </button>
                    ) : (
                      <small>
                        {analysis
                          ? !analysis.complete || analysis.truncated
                            ? "回答未完整结束"
                            : "整理完成，等待你核对"
                          : "调用可能计费"}
                      </small>
                    )}
                  </div>
                  {aiBusy && (
                    <p className="helper" role="status">
                      {aiProgress || "正在直连你的 AI 服务…"}
                    </p>
                  )}
                  {aiText && <pre className="ai-result">{aiText}</pre>}
                  {analysis && (
                    <label className="check-line">
                      <input
                        type="checkbox"
                        checked={includeAI}
                        onChange={(e) => setIncludeAI(e.target.checked)}
                      />
                      {!analysis.complete || analysis.truncated
                        ? "我已核对，接受并保存这份不完整回答"
                        : "将这份整理与原文一起沉淀"}
                    </label>
                  )}
                  {aiText && !analysis && !aiBusy && (
                    <p className="warning">
                      这是未完成请求的部分文字，不会自动收录；可手动复制核对。
                    </p>
                  )}
                </section>
              )}
              <footer className="compose-footer">
                <div className="row spread">
                  <span className="draft-status" role="status">
                    {draftStatus || "原话值得留下来"}
                  </span>
                  <button
                    className="icon-button"
                    aria-label="导出当前捕获包"
                    onClick={() => void exportCurrent({ ...capture, analysis })}
                  >
                    <ArrowDownToLine size={15} />
                  </button>
                </div>
                <button
                  className="primary full save-button"
                  disabled={saving || aiBusy || !ready}
                  onClick={() => void submit()}
                >
                  {saving
                    ? "正在保存…"
                    : state.auth
                      ? state.auth.scopes.includes("knowledge:write")
                        ? "沉淀到我的空间"
                        : "提交到系统待采纳"
                      : "先留在本机"}
                  <span>
                    {saving ? (
                      <RefreshCw size={15} />
                    ) : (
                      <ArrowUpRight size={17} />
                    )}
                  </span>
                </button>
                <p className="keyboard-hint">
                  Ctrl / ⌘ + Enter · 原文不会被 AI 覆盖
                </p>
              </footer>
            </main>
          ) : (
            <main className="drafts-page">
              <div className="section-heading">
                <div>
                  <div className="eyebrow">不急着整理</div>
                  <h1>想法，都留着。</h1>
                </div>
                <button
                  className="icon-button"
                  aria-label="导入程序生成的捕获包"
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload size={17} />
                </button>
              </div>
              <p className="muted lead">草稿和待同步记录只存在这台设备上。</p>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importFile(f);
                  e.target.value = "";
                }}
              />
              {state.drafts.length === 0 && pending.length === 0 && (
                <div className="empty-state">
                  <FileText size={26} />
                  <h2>这里还很安静。</h2>
                  <p>写一个想法，或者读完一段值得留下的文字。</p>
                  <button className="secondary" onClick={() => void startNew()}>
                    写下第一句话
                  </button>
                </div>
              )}
              {state.drafts.length > 0 && (
                <>
                  <h2 className="list-heading">
                    设备草稿 <span>{state.drafts.length}</span>
                  </h2>
                  {state.drafts
                    .slice()
                    .reverse()
                    .map((d) => (
                      <article className="draft-row" key={d.ownerKey + d.id}>
                        <button
                          className="draft-open"
                          onClick={() => {
                            restore(d.capture);
                            if (d.ownerKey === "device" && state.auth)
                              notify(
                                "这是未关联账号的设备草稿。点击沉淀才会写入当前账号。",
                              );
                          }}
                        >
                          <strong>
                            {d.capture.title ||
                              d.capture.thought ||
                              d.capture.text.slice(0, 42) ||
                              "仅保存来源链接"}
                          </strong>
                          <p>
                            {(d.capture.thought || d.capture.text).slice(
                              0,
                              100,
                            )}
                          </p>
                          <small>
                            {formatTime(d.updatedAt)}
                            {d.ownerKey === "device" ? " · 未关联账号" : ""}
                          </small>
                        </button>
                        <div className="row">
                          <button
                            className="icon-button"
                            aria-label="导出草稿"
                            onClick={() => void exportCurrent(d.capture)}
                          >
                            <ArrowDownToLine size={14} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label="删除设备草稿"
                            onClick={() => {
                              if (
                                confirm(
                                  "删除此设备上的草稿？尚未沉淀的内容将无法恢复。",
                                )
                              )
                                void message("draft.remove", {
                                  id: d.id,
                                }).catch((e) => notify(e.message));
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </article>
                    ))}
                </>
              )}
              {state.queue.length > 0 && (
                <>
                  <h2 className="list-heading">同步与最近收录</h2>
                  {state.queue
                    .slice()
                    .reverse()
                    .map((q) => (
                      <article className="queue-row" key={q.id}>
                        <div className="row spread">
                          <strong>
                            {q.capture.title ||
                              q.capture.text.slice(0, 40) ||
                              q.capture.thought.slice(0, 40) ||
                              "来源链接"}
                          </strong>
                          <span className={"queue-status " + q.status}>
                            {q.status === "saved" && <Check size={11} />}{" "}
                            {statusLabel(q)}
                          </span>
                        </div>
                        <small>
                          {formatTime(q.updatedAt)} · {q.attempts} 次发送
                          {q.grantId !== state.auth?.grantId
                            ? " · 原授权已更换"
                            : ""}
                        </small>
                        {q.error && <p className="warning">{q.error}</p>}
                        <div className="row">
                          {q.status === "failed" &&
                            q.grantId === state.auth?.grantId && (
                              <button
                                className="text-button small"
                                onClick={() =>
                                  void message("queue.retry", {
                                    id: q.id,
                                  }).catch((e) => notify(e.message))
                                }
                              >
                                <RefreshCw size={12} />
                                用原标识重试
                              </button>
                            )}
                          <button
                            className="text-button small"
                            onClick={() => void exportCurrent(q.capture)}
                          >
                            导出捕获包
                          </button>
                          {["saved", "proposal"].includes(q.status) && (
                            <button
                              className="text-button small"
                              onClick={() => openSystem(q.origin)}
                            >
                              打开知识空间
                              <ArrowUpRight size={11} />
                            </button>
                          )}
                          <button
                            className="text-button small"
                            disabled={q.status === "sending"}
                            onClick={() => {
                              if (
                                confirm(
                                  q.attempts > 0 &&
                                    !["saved", "proposal"].includes(q.status)
                                    ? "可能已写入系统但尚未收到确认。移出只删除本机任务，不会撤销系统记录；请先核对是否已入库。"
                                    : "移出本机列表？不会删除系统里的记录。",
                                )
                              )
                                void message("queue.remove", {
                                  id: q.id,
                                }).catch((e) => notify(e.message));
                            }}
                          >
                            移出
                          </button>
                        </div>
                      </article>
                    ))}
                </>
              )}
              <p className="privacy-note">
                网络失败不会新建第二条帖子；但更换授权会改变服务端幂等身份。旧授权的待同步项需要先核对，不能自动转给新授权重发。
              </p>
            </main>
          )}
        </>
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={14} />
          </button>
        </div>
      )}
      <div className="panel-signature">
        <span>记录，是理解的开始。</span>
        <span>沉淀 · 0.1</span>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Panel />);
