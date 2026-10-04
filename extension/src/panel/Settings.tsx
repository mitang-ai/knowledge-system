import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import {
  discoverModels,
  generate,
  mergeModels,
  safeAIError,
} from "../../../src/ai/client";
import type { AIConnection } from "../../../src/ai/types";
import { connectOAuth } from "../core/oauth";
import { serviceOrigin } from "../core/capture";
import { taskNames } from "../core/ai";
import { allowHost, aiAddress } from "../platform/permissions";
import {
  forgetProvider,
  providerKey,
  saveProviderKey,
  saveAISettings,
} from "../platform/storage";
import { message } from "../platform/messages";
import { DEFAULT_ORIGIN, DEFAULT_RESOURCE } from "../types";
import type {
  AISettings,
  AuthSession,
  ProviderDefinition,
  PublicSession,
} from "../types";
import { openSystem } from "./utils";

export function Settings({
  auth,
  owner,
  settings,
  onSettings,
  onBack,
  notify,
  beforeSwitch,
}: {
  auth: PublicSession | null;
  owner: string;
  settings: AISettings;
  onSettings: (s: AISettings) => void;
  onBack: () => void;
  notify: (s: string) => void;
  beforeSwitch: () => Promise<void>;
}) {
  const [section, setSection] = useState<"system" | "ai" | "about">("system"),
    [origin, setOrigin] = useState(auth?.origin || DEFAULT_ORIGIN),
    [resource, setResource] = useState(auth?.resource || DEFAULT_RESOURCE),
    [token, setToken] = useState(""),
    [busy, setBusy] = useState(""),
    [editing, setEditing] = useState<ProviderDefinition | null>(null),
    [key, setKey] = useState(""),
    [manual, setManual] = useState(""),
    [filter, setFilter] = useState("");
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!editing) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        setEditing(null);
        setKey("");
      }
      if (e.key === "Tab") {
        const nodes = [
          ...(dialog.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),select:not(:disabled)",
          ) || []),
        ];
        const first = nodes[0],
          last = nodes.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      previous?.focus();
    };
  }, [!!editing, busy]);
  const updateProvider = (change: Partial<ProviderDefinition>) =>
    setEditing((p) => (p ? { ...p, ...change } : p));
  const persist = async (s: AISettings) => {
    await saveAISettings(owner, s);
    onSettings(s);
  };
  const connect = async (method: "oauth" | "token") => {
    setBusy("connect");
    try {
      const host = serviceOrigin(origin);
      await allowHost(host);
      await beforeSwitch();
      if (method === "oauth") {
        const next = await connectOAuth(
          host,
          resource,
          chrome.identity.getRedirectURL("sediment"),
          async (url) => {
            const result = await chrome.identity.launchWebAuthFlow({
              url,
              interactive: true,
            });
            if (!result) throw new Error("授权窗口关闭，未连接系统。");
            return result;
          },
        );
        await message("auth.install", { auth: next });
      } else await message("auth.token", { origin: host, token });
      setToken("");
      notify(
        "已连接。页面授权里勾选直接写入才能一键入库；否则只提交待采纳建议。",
      );
    } catch (e) {
      notify(e instanceof Error ? e.message : "连接未完成。");
    } finally {
      setBusy("");
    }
  };
  const disconnect = async () => {
    setBusy("disconnect");
    try {
      await beforeSwitch();
      const r = await message<{ revoked: boolean }>("auth.disconnect");
      notify(
        r.revoked
          ? "已撤销授权并断开连接。"
          : "已在本机断开。请到系统连接设置撤销范围授权；未声称服务端已撤销。",
      );
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const edit = async (p: ProviderDefinition) => {
    setEditing(structuredClone(p));
    setKey(await providerKey(owner, p.id));
    setManual("");
    setFilter("");
  };
  const resolve = (p: ProviderDefinition): AIConnection => ({
    ...p,
    key,
    allowUnauthenticated: p.localUnauthenticated,
  });
  const providerAction = async (action: "discover" | "test" | "save") => {
    if (!editing) return;
    setBusy(action);
    try {
      const address = aiAddress(editing.baseUrl, auth?.origin || origin);
      if (
        editing.localUnauthenticated &&
        (editing.protocol !== "openai" ||
          !["localhost", "127.0.0.1", "[::1]"].includes(
            new URL(address).hostname,
          ))
      )
        throw new Error("无 Key 模式只允许本机 OpenAI 兼容接口。");
      await allowHost(address);
      const connection = { ...resolve(editing), baseUrl: address };
      if (action === "discover") {
        const found = await discoverModels(
          connection,
          AbortSignal.timeout(30000),
        );
        updateProvider({ models: mergeModels(editing.models, found) });
        notify(
          `探测到 ${found.length} 个模型。目录存在不代表这个 Key 能调用，请自行测试。`,
        );
      } else if (action === "test") {
        const model = editing.models.find((m) => m.enabled)?.id;
        if (!model)
          throw new Error("先勾选一个常用模型，测试将调用第一个勾选的模型。");
        const r = await generate(
          connection,
          model,
          [{ role: "user", content: "仅回答 OK，不包含任何网页资料。" }],
          { signal: AbortSignal.timeout(30000), maxTokens: 64 },
        );
        notify("调用成功。返回模型：" + (r.model || "服务未声明"));
      } else {
        if (!editing.name.trim()) throw new Error("给这个服务起一个名字。");
        if (!key.trim() && !editing.localUnauthenticated)
          throw new Error("填写 API Key；仅本机无认证服务可留空。");
        const next = {
          ...editing,
          baseUrl: address,
          name: editing.name.trim(),
        };
        await saveProviderKey(owner, next.id, key, next.remember);
        await persist({
          ...settings,
          providers: settings.providers.some((p) => p.id === next.id)
            ? settings.providers.map((p) => (p.id === next.id ? next : p))
            : [...settings.providers, next],
        });
        setEditing(null);
        setKey("");
        notify("已保存到本机。没有同步 Key 到浏览器账号或知识系统。");
      }
    } catch (e) {
      notify(
        e instanceof Error && e.name !== "AIError" ? e.message : safeAIError(e),
      );
    } finally {
      setBusy("");
    }
  };
  const remove = async (p: ProviderDefinition) => {
    if (!confirm("删除这个服务及本机保存的 Key？不会撤销服务商的 Key。"))
      return;
    await forgetProvider(owner, p.id);
    await persist({
      ...settings,
      providers: settings.providers.filter((x) => x.id !== p.id),
    });
  };
  const enabled = settings.providers.flatMap((p) =>
    p.models
      .filter((m) => m.enabled)
      .map((m) => ({ id: p.id + "::" + m.id, label: p.name + " · " + m.name })),
  );
  return (
    <section className="settings">
      <button className="back" onClick={onBack}>
        <ArrowLeft size={16} />
        回到随手记
      </button>
      <h1>按你的习惯来。</h1>
      <p className="muted lead">系统负责沉淀，AI 由你自己选择。</p>
      <nav className="tabs" aria-label="设置类别">
        {(
          [
            ["system", "连接系统"],
            ["ai", "AI 与模型"],
            ["about", "使用与隐私"],
          ] as const
        ).map(([id, label]) => (
          <button
            aria-selected={section === id}
            onClick={() => setSection(id)}
            key={id}
          >
            {label}
          </button>
        ))}
      </nav>
      {section === "system" && (
        <>
          <div className="section-heading">
            <h2>你的知识空间</h2>
            {auth && <span className="status-dot">已连接</span>}
          </div>
          <label className="field">
            系统地址
            <input
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              placeholder={DEFAULT_ORIGIN}
              type="url"
            />
          </label>
          {auth && (
            <div className="quiet-card">
              <strong>{new URL(auth.origin).hostname}</strong>
              <small>
                账号标识 {auth.subject.slice(0, 8)} ·{" "}
                {auth.scopes.includes("knowledge:write")
                  ? "允许直接沉淀"
                  : auth.scopes.includes("proposals:create")
                    ? "仅提交待采纳"
                    : "只读授权"}
              </small>
              <small>
                只显示与同步当前账号的数据；替换授权不会自动重发旧提交。
              </small>
            </div>
          )}
          <button
            className="primary full"
            disabled={!!busy}
            onClick={() => void connect("oauth")}
          >
            {busy === "connect"
              ? "等待你在授权页确认…"
              : auth
                ? "重新授权 / 切换账号"
                : "连接我的知识空间"}
            <ArrowUpRight size={16} />
          </button>
          <p className="helper">
            登录在系统自己的授权窗口完成，插件不接触密码。请勾选“直接写入”并设定每日额度；不勾选时，收录会进入系统待采纳区。
          </p>
          <details>
            <summary>手动令牌与高级连接</summary>
            <label className="field">
              授权资源地址
              <input
                value={resource}
                onChange={(e) => setResource(e.target.value)}
              />
            </label>
            <p className="helper">
              这是系统配置的 OAuth
              audience，不会连接这个地址。可在系统“连接与迁移”查看 MCP 地址。
            </p>
            <label className="field">
              范围授权令牌
              <input
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="在系统连接设置创建，建议单独给此插件授权"
              />
            </label>
            <button
              className="secondary full"
              disabled={!!busy || !token}
              onClick={() => void connect("token")}
            >
              验证并连接
            </button>
          </details>
          {auth && (
            <div className="row spread">
              <button
                className="text-button"
                onClick={() => openSystem(auth.origin)}
              >
                打开知识空间
                <ArrowUpRight size={14} />
              </button>
              <button
                className="text-button"
                disabled={!!busy}
                onClick={() => void disconnect()}
              >
                断开连接
              </button>
            </div>
          )}
        </>
      )}
      {section === "ai" && (
        <>
          <div className="section-heading">
            <h2>自己的 AI 服务</h2>
            <button
              className="icon-button"
              aria-label="添加 AI 服务"
              onClick={() => {
                setEditing({
                  id: crypto.randomUUID(),
                  name: "我的 AI",
                  protocol: "openai",
                  apiType: "chat",
                  baseUrl: "https://api.openai.com/v1",
                  remember: false,
                  models: [],
                });
                setKey("");
                setManual("");
                setFilter("");
              }}
            >
              <Plus size={17} />
            </button>
          </div>
          <p className="helper">
            多选常用模型，运行任务时单选。不会因多选就自动并发调用，也不会静默换模型。
          </p>
          {settings.providers.length === 0 && (
            <div className="quiet-card">
              <strong>不接入 AI 也能用。</strong>
              <p>你的原文和想法，始终可以直接沉淀。</p>
            </div>
          )}
          {settings.providers.map((p) => (
            <div className="provider-row" key={p.id}>
              <button onClick={() => void edit(p)}>
                <strong>{p.name}</strong>
                <small>
                  {p.models.filter((m) => m.enabled).length} 个常用模型 ·{" "}
                  {p.remember ? "Key 留在此设备" : "Key 仅本次浏览器会话"}
                </small>
              </button>
              <button
                className="icon-button"
                aria-label={"删除 " + p.name}
                onClick={() => void remove(p).catch((e) => notify(e.message))}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {enabled.length > 0 && (
            <>
              <h2 className="space-top">不同任务，各有所长。</h2>
              {Object.entries(taskNames).map(([task, label]) => (
                <label className="field" key={task}>
                  {label}的默认模型
                  <select
                    value={
                      settings.defaultModels[task as keyof typeof taskNames] ||
                      ""
                    }
                    onChange={(e) =>
                      void persist({
                        ...settings,
                        defaultModels: {
                          ...settings.defaultModels,
                          [task]: e.target.value,
                        },
                      }).catch((e) => notify(e.message))
                    }
                  >
                    <option value="">使用第一个常用模型</option>
                    {enabled.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <label className="field">
                每次回答的输出上限
                <select
                  value={settings.maxTokens}
                  onChange={(e) =>
                    void persist({
                      ...settings,
                      maxTokens: Number(e.target.value),
                    }).catch((e) => notify(e.message))
                  }
                >
                  {[512, 1024, 2048, 4096].map((n) => (
                    <option value={n} key={n}>
                      {n} tokens
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <p className="privacy-note">
            所有服务地址、模型选择和 Key 均只留在本机扩展存储，不用
            chrome.storage.sync。浏览器存储不是加密保险箱；选中材料和 Key
            会直达你选的 AI 服务。真正离线推理需要你自己运行本地模型。
          </p>
        </>
      )}
      {section === "about" && (
        <div className="about">
          <h2>先记下来，再慢慢想。</h2>
          <p>
            <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>N</kbd> 打开速记
            <br />
            <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>S</kbd>{" "}
            一键沉淀当前页面或选区
            <br />
            <kbd>Ctrl / ⌘</kbd> + <kbd>Enter</kbd> 保存当前记录
          </p>
          <p>
            工具栏图标、右键或快捷键只授权读取你正在操作的标签页。切换页面后若无法读取，请再次点图标。不请求浏览历史、Cookie、剪贴板或所有网站的常驻内容权限。
          </p>
          <p>
            文章抓取的是已展示、可提取的正文，不保证整站镜像。X 与 Reddit
            只包含已加载内容；不自动翻页或展开讨论。PDF、封闭 Shadow DOM 和跨域
            iframe 请选字、粘贴正文或在系统导入文件。
          </p>
          <p>
            图片仅保留链接，不等于图片已归档。原文与 AI 整理分开保存。AI
            不自动执行网页里的指令，不自行访问新链接。
          </p>
          <p>
            断网或限流时待同步记录保留在此设备。重试只用原提交标识，最多自动尝试
            5
            次。更换账号或授权后不自动重发原授权的任务。卸载扩展会删除本机草稿，请先导出。
          </p>
          <p>
            程序接口：<code>sediment.capture.v1</code> 捕获包与{" "}
            <code>/api/v1/write</code>。SDK 与 JSON Schema
            随安装包提供；普通网页不能调用插件的秘密操作。
          </p>
          <small>沉淀 · 随手记 0.1.0 · Edge / Chrome MV3</small>
        </div>
      )}
      {editing && (
        <div className="modal-backdrop">
          <section
            ref={dialog}
            className="provider-editor"
            role="dialog"
            aria-modal="true"
            aria-label="配置 AI 服务"
          >
            <div className="section-heading">
              <h2>配置 AI 服务</h2>
              <button
                className="icon-button"
                aria-label="关闭 AI 配置"
                disabled={!!busy}
                onClick={() => {
                  setEditing(null);
                  setKey("");
                }}
              >
                <X size={18} />
              </button>
            </div>
            <label className="field">
              服务名称
              <input
                value={editing.name}
                maxLength={50}
                onChange={(e) => updateProvider({ name: e.target.value })}
              />
            </label>
            <div className="two-col">
              <label className="field">
                协议
                <select
                  value={editing.protocol}
                  onChange={(e) =>
                    updateProvider({
                      protocol: e.target.value as "openai" | "anthropic",
                    })
                  }
                >
                  <option value="openai">OpenAI 兼容</option>
                  <option value="anthropic">Anthropic</option>
                </select>
              </label>
              <label className="field">
                接口
                <select
                  value={editing.apiType}
                  disabled={editing.protocol === "anthropic"}
                  onChange={(e) =>
                    updateProvider({
                      apiType: e.target.value as "chat" | "responses",
                    })
                  }
                >
                  <option value="chat">Chat Completions</option>
                  <option value="responses">Responses</option>
                </select>
              </label>
            </div>
            <label className="field">
              API 根地址
              <input
                type="url"
                value={editing.baseUrl}
                onChange={(e) => updateProvider({ baseUrl: e.target.value })}
                placeholder="https://你的服务/v1"
              />
            </label>
            <button
              className="text-button small"
              onClick={() =>
                updateProvider({
                  baseUrl: "http://localhost:11434/v1",
                  protocol: "openai",
                  apiType: "chat",
                  localUnauthenticated: true,
                  name: "本地 Ollama",
                })
              }
            >
              使用本地 Ollama 示例
            </button>
            <label className="field">
              API Key
              <input
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="只保存在你的浏览器"
              />
            </label>
            <label className="check-line">
              <input
                type="checkbox"
                checked={editing.remember}
                onChange={(e) => updateProvider({ remember: e.target.checked })}
              />
              记住此设备的 Key（默认仅本次浏览器会话）
            </label>
            <label className="check-line">
              <input
                type="checkbox"
                checked={!!editing.localUnauthenticated}
                onChange={(e) =>
                  updateProvider({ localUnauthenticated: e.target.checked })
                }
              />
              本机 OpenAI 兼容接口无需 Key
            </label>
            <div className="row">
              <button
                className="secondary"
                disabled={!!busy}
                onClick={() => void providerAction("discover")}
              >
                <RefreshCw size={14} />
                {busy === "discover" ? "正在探测…" : "探测模型"}
              </button>
              <button
                className="text-button small"
                disabled={!!busy}
                onClick={() => void providerAction("test")}
              >
                测试调用 · 可能计费
              </button>
            </div>
            <label className="field">
              手动添加准确的模型 ID
              <div className="input-action">
                <input
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  placeholder="目录不支持时可手动添加"
                />
                <button
                  className="icon-button"
                  aria-label="添加模型 ID"
                  onClick={() => {
                    const id = manual.trim();
                    if (!id || id.length > 200) return;
                    updateProvider({
                      models: editing.models.some((m) => m.id === id)
                        ? editing.models
                        : [
                            ...editing.models,
                            {
                              id,
                              name: id,
                              enabled: true,
                              manual: true,
                              capabilities: "能力未确认",
                            },
                          ],
                    });
                    setManual("");
                  }}
                >
                  <Plus size={16} />
                </button>
              </div>
            </label>
            {editing.models.length > 0 && (
              <>
                <label className="field">
                  常用模型（可多选）
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="筛选模型"
                  />
                </label>
                <div className="model-list">
                  {editing.models
                    .filter((m) =>
                      (m.id + " " + m.name)
                        .toLowerCase()
                        .includes(filter.toLowerCase()),
                    )
                    .map((m) => (
                      <label className="model-row" key={m.id}>
                        <input
                          type="checkbox"
                          checked={m.enabled}
                          onChange={(e) =>
                            updateProvider({
                              models: editing.models.map((x) =>
                                x.id === m.id
                                  ? { ...x, enabled: e.target.checked }
                                  : x,
                              ),
                            })
                          }
                        />
                        <span>
                          <strong>{m.name}</strong>
                          <small>
                            {m.id}
                            {m.missing
                              ? " · 目录未列出"
                              : m.manual
                                ? " · 手动添加"
                                : " · 调用能力尚未验证"}
                          </small>
                        </span>
                      </label>
                    ))}
                </div>
              </>
            )}
            <button
              className="primary full"
              disabled={!!busy}
              onClick={() => void providerAction("save")}
            >
              <Check size={16} />
              保存服务与模型
            </button>
          </section>
        </div>
      )}
    </section>
  );
}
