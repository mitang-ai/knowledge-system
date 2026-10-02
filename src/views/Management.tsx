import {
  Archive,
  ArrowRight,
  CheckCircle2,
  Copy,
  Download,
  FileText,
  FolderOpen,
  Inbox,
  Layers,
  LockKeyhole,
  Monitor,
  Paperclip,
  PenLine,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  active,
  api,
  colorOf,
  dateOf,
  download,
  kindLabel,
  markdown,
  stamp,
  titleOf,
} from "../lib";

import { roleLabel } from "../lib";
import { Count, Empty, IconButton, PageHeading, SectionTitle } from "../ui";
import { useWorkspace } from "../workspace";
import { NoteList } from "./Knowledge";
interface PlatformData {
  accounts: { id: string; email: string; disabled: number }[];
  spaces: {
    id: string;
    name: string;
    description: string;
    owner: string;
    member_count: number;
  }[];
  items: number;
  files: number;
  backups: number;
  runtime: string;
}
export function PlatformView() {
  const { ws, dialog, notify } = useWorkspace();
  const [data, setData] = useState<PlatformData | null>(null),
    [error, setError] = useState("");
  const load = () =>
    api<PlatformData>("platform")
      .then(setData)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  if (error) return <div className="form-error">{error}</div>;
  if (!data) return <p className="muted">正在读取平台状态…</p>;
  return (
    <>
      <div className="platform-intro">
        <div>
          <span className="small-label">实例管理</span>
          <h2>用户与空间，独立维护</h2>
          <p>平台管理只呈现账号状态和空间元信息。个人正文不会在此列出。</p>
        </div>
        <span className="tag">
          <ShieldCheck size={12} />
          平台所有者
        </span>
      </div>
      <div className="platform-stats">
        {[
          [data.accounts.length, "注册账号"],
          [data.spaces.length, "团队空间"],
          [data.items, "内容对象"],
          [data.backups, "备份快照"],
        ].map(([n, label]) => (
          <div key={label}>
            <strong>{n}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <section className="management-section">
        <SectionTitle title="账号管理" count={data.accounts.length} />
        <div className="platform-accounts">
          {data.accounts.map((a) => (
            <div key={a.id}>
              <span className="user-avatar">
                {(
                  ws.profiles.find((p) => p.owner_id === a.id)?.display_name ||
                  a.email
                ).slice(0, 1)}
              </span>
              <div>
                <strong>
                  {ws.profiles.find((p) => p.owner_id === a.id)?.display_name ||
                    a.email}
                </strong>
                <small>{a.email}</small>
              </div>
              <span className={"tag " + (!a.disabled ? "green-tag" : "")}>
                {a.disabled
                  ? "已停用"
                  : a.id === ws.me.owner_id
                    ? "平台所有者"
                    : "已启用"}
              </span>
              {a.id !== ws.me.owner_id && (
                <button
                  className="quiet-button"
                  onClick={() =>
                    dialog({
                      type: "confirm",
                      title: a.disabled ? "恢复账号访问" : "停用账号",
                      message: a.disabled
                        ? "该账号可以重新登录。原内容与团队归属保持完整。"
                        : "此账号将立即退出登录并暂停访问，知识内容保留，之后可以恢复。",
                      action: async () => {
                        await api("platform/accounts", {
                          id: a.id,
                          disabled: !a.disabled,
                        });
                        await load();
                        notify(a.disabled ? "账号已恢复" : "账号已停用");
                      },
                    })
                  }
                >
                  {a.disabled ? "恢复账号" : "停用账号"}
                </button>
              )}
            </div>
          ))}
        </div>
        {!data.accounts.length && (
          <div className="inline-empty">
            <LockKeyhole size={16} />
            当前仍为本地个人模式。在偏好设置中启用账号登录后，可以管理新注册账号。
          </div>
        )}
      </section>
      <section className="management-section">
        <SectionTitle title="团队空间概览" count={data.spaces.length} />
        <div className="platform-spaces">
          {data.spaces.map((s) => (
            <div key={s.id}>
              <Users size={19} />
              <div>
                <strong>{s.name}</strong>
                <small>{s.description || "尚未填写说明"}</small>
              </div>
              <span>{s.member_count} 位成员</span>
              <span className="tag">
                所有者：
                {ws.profiles.find((p) => p.owner_id === s.owner)
                  ?.display_name || "未知用户"}
              </span>
            </div>
          ))}
        </div>
        {!data.spaces.length && (
          <div className="inline-empty">尚未创建团队空间。</div>
        )}
      </section>
      <div className="info-strip platform-runtime">
        <Monitor size={15} />
        {data.runtime} · {data.files}{" "}
        个本地文件。此交付版用于本地运行；公开服务还需生产认证、分页检索、对象存储与异地备份。
      </div>
    </>
  );
}

export function ManageView() {
  const { ws, scoped, topics, space, go, open, dialog, save, refresh, notify } =
    useWorkspace();
  const [tab, setTab] = useState("health"),
    [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const notes = scoped.filter((x) => x.type !== "topic" && active(x));
  const inbox = notes.filter(
      (x) => !x.topic_ids.some((id) => topics.some((t) => t.id === id)),
    ),
    blank = topics.filter((t) => !t.body.trim()),
    deleted = scoped.filter(
      (x) => x.deleted_at && x.owner_id === ws.me.owner_id,
    ),
    archived = notes.filter((x) => x.archived),
    missing = [
      ...scoped,
      ...ws.replies.filter((r) => scoped.some((n) => n.id === r.item_id)),
    ].flatMap((x) => (x.atts || []).filter((a) => !a.local));
  const duplicates = notes.filter(
    (x, i) =>
      notes.findIndex(
        (y) =>
          y.body.trim().replace(/\s/g, "") ===
            x.body.trim().replace(/\s/g, "") && y.body.trim(),
      ) !== i && x.body.trim(),
  );
  const team = ws.spaces.find((s) => s.id === space),
    members = ws.members.filter((m) => m.space === space);
  const backup = async () => {
    setBusy(true);
    try {
      await api("backups", {});
      await refresh();
      notify("完整快照已保存");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const exportAll = () => {
    download(
      "沉淀-知识手册.md",
      scoped
        .filter(
          (x) =>
            x.type !== "topic" && active(x) && x.owner_id === ws.me.owner_id,
        )
        .map((x) => markdown(x, ws.items, ws.replies))
        .join("\n---\n\n"),
    );
    notify("当前空间的自有内容已导出");
  };
  return (
    <>
      <PageHeading
        title="管理工作台"
        eyebrow={space ? "团队知识治理" : "让知识保持清晰"}
        description="整理内容，维护主题，让积累能持续使用。"
        actions={
          <button className="quiet-button" onClick={backup} disabled={busy}>
            <Archive size={15} />
            立即备份
          </button>
        }
      />
      <div className="manage-tabs filter-tabs bordered-tabs">
        {[
          { id: "health", name: "内容治理" },
          { id: "topics", name: "主题管理" },
          { id: "data", name: "数据与备份" },
          { id: "trash", name: "回收站" },
          { id: "members", name: "团队成员" },
          ...(ws.platform_admin ? [{ id: "platform", name: "平台管理" }] : []),
        ].map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "selected" : ""}
            onClick={() => setTab(t.id)}
          >
            {t.name}
            {t.id === "trash" && deleted.length > 0 && (
              <Count>{deleted.length}</Count>
            )}
          </button>
        ))}
      </div>
      {tab === "health" && (
        <>
          <div className="health-summary">
            <div>
              <span className="small-label">知识状态</span>
              <h2>
                {inbox.length || blank.length
                  ? "有一些内容，值得整理一下"
                  : "知识空间保持整洁"}
              </h2>
              <p>
                共 {notes.length} 条知识，连接 {topics.length}{" "}
                个主题。管理操作保留历史，原始记录不会被静默覆盖。
              </p>
            </div>
            <span className="health-emblem">
              <Layers size={34} strokeWidth={1.1} />
            </span>
          </div>
          <div className="health-grid">
            <button onClick={() => go("inbox")}>
              <Inbox size={21} />
              <strong>{inbox.length}</strong>
              <h3>等待归类</h3>
              <p>为散落的想法关联主题</p>
              <ArrowRight size={16} />
            </button>
            <button onClick={() => setTab("topics")}>
              <Layers size={21} />
              <strong>{blank.length}</strong>
              <h3>主题缺少说明</h3>
              <p>说明这个主题收什么内容</p>
              <ArrowRight size={16} />
            </button>
            <button
              onClick={() =>
                document
                  .getElementById("duplicate-section")
                  ?.scrollIntoView({ behavior: "smooth" })
              }
            >
              <Copy size={21} />
              <strong>{duplicates.length}</strong>
              <h3>正文完全重复</h3>
              <p>人工确认后决定是否保留</p>
              <ArrowRight size={16} />
            </button>
            <button
              onClick={() =>
                notify(
                  "历史附件引用缺少文件本体，可在记录中查看路径并重新上传。",
                )
              }
            >
              <Paperclip size={21} />
              <strong>{missing.length}</strong>
              <h3>缺少附件文件</h3>
              <p>保留引用，等待补齐原件</p>
              <ArrowRight size={16} />
            </button>
          </div>
          <section className="management-section" id="duplicate-section">
            <SectionTitle title="重复内容检查" count={duplicates.length} />
            {duplicates.length ? (
              <NoteList items={duplicates} />
            ) : (
              <div className="inline-empty">
                <CheckCircle2 size={17} />
                没有发现正文完全相同的重复记录。
              </div>
            )}
          </section>
          <section className="management-section">
            <SectionTitle title="已归档内容" count={archived.length} />
            {archived.length ? (
              <div className="management-rows">
                {archived.map((n) => (
                  <div key={n.id}>
                    <button onClick={() => open(n.id)}>
                      <FileText size={16} />
                      {titleOf(n)}
                    </button>
                    {n.owner_id === ws.me.owner_id && (
                      <button
                        className="text-button"
                        onClick={() =>
                          void save({ ...n, archived: false }).catch((e) =>
                            notify(e.message),
                          )
                        }
                      >
                        取消归档
                        <RotateCcw size={13} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="inline-empty">
                暂时没有归档的记录。归档内容保留全文和关联。
              </div>
            )}
          </section>
        </>
      )}
      {tab === "topics" && (
        <>
          <SectionTitle
            title="主题与边界"
            count={topics.length}
            action={
              <button
                className="quiet-button"
                onClick={() => dialog({ type: "topic" })}
              >
                <Plus size={14} />
                新建主题
              </button>
            }
          />
          <div className="management-topic-table">
            <div className="table-head">
              <span>主题名称与说明</span>
              <span>关联知识</span>
              <span>维护</span>
            </div>
            {topics.map((t, i) => (
              <div className="table-row" key={t.id}>
                <div>
                  <span
                    className="topic-dot"
                    style={{ background: colorOf(t, i) }}
                  />
                  <div>
                    <strong>{titleOf(t)}</strong>
                    <p>{t.body || "还没有说明 · 建议补充主题边界"}</p>
                  </div>
                </div>
                <span>
                  {notes.filter((n) => n.topic_ids.includes(t.id)).length} 条
                </span>
                <div>
                  {t.owner_id === ws.me.owner_id && (
                    <>
                      <IconButton
                        label={"编辑主题 " + titleOf(t)}
                        onClick={() => dialog({ type: "topic", item: t })}
                      >
                        <PenLine size={15} />
                      </IconButton>
                      <IconButton
                        label={"合并主题 " + titleOf(t)}
                        onClick={() => dialog({ type: "merge", item: t })}
                      >
                        <Layers size={15} />
                      </IconButton>
                      <IconButton
                        label={"删除主题 " + titleOf(t)}
                        onClick={() =>
                          dialog({
                            type: "confirm",
                            title: "删除主题",
                            message:
                              "主题会移入回收站，关联记录和补充继续保留。恢复主题后原关联仍可使用。",
                            action: async () => {
                              await save({ ...t, deleted_at: stamp() });
                              notify("主题已移入回收站");
                            },
                          })
                        }
                      >
                        <Trash2 size={15} />
                      </IconButton>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          {!topics.length && (
            <Empty
              title="主题为空"
              description="创建一个主题，为持续关注的方向留出位置。"
            />
          )}
        </>
      )}
      {tab === "data" && (
        <>
          <div className="data-export-grid">
            <button onClick={exportAll}>
              <FileText size={24} />
              <h3>知识手册</h3>
              <p>当前空间的自有记录、理解和补充</p>
              <span>
                导出 Markdown
                <Download size={14} />
              </span>
            </button>
            <button
              onClick={() =>
                void api("export")
                  .then((x) => {
                    download(
                      "沉淀-完整备份.json",
                      JSON.stringify(x, null, 2),
                      "application/json",
                    );
                    notify("个人完整备份已导出");
                  })
                  .catch((e) => notify(e.message))
              }
            >
              <Archive size={24} />
              <h3>完整备份</h3>
              <p>自有内容、补充、版本与排版设置</p>
              <span>
                导出 JSON
                <Download size={14} />
              </span>
            </button>
            <a href="/api/archive" download="沉淀-完整归档.zip">
              <FolderOpen size={24} />
              <h3>含附件的归档</h3>
              <p>结构化数据、本地文件与缺失清单</p>
              <span>
                下载 ZIP
                <Download size={14} />
              </span>
            </a>
          </div>
          <div className="import-strip">
            <div>
              <h3>从备份继续积累</h3>
              <p>
                导入新版 JSON 时按 ID
                合并，操作前先自动备份。附件可在记录中重新上传。
              </p>
            </div>
            <button
              className="quiet-button"
              disabled={busy}
              onClick={() => file.current?.click()}
            >
              <Download className="rotate-180" size={15} />
              导入 JSON
            </button>
          </div>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const chosen = e.target.files?.[0];
              if (!chosen) return;
              setBusy(true);
              try {
                const payload = JSON.parse(await chosen.text());
                const result = await api<{ items: number; replies: number }>(
                  "import",
                  payload,
                );
                await refresh();
                notify(
                  `已合并 ${result.items} 条内容、${result.replies} 条补充`,
                );
              } catch (e) {
                notify((e as Error).message);
              } finally {
                setBusy(false);
                e.target.value = "";
              }
            }}
          />
          <section className="backup-section">
            <SectionTitle
              title="备份快照"
              count={ws.backups.length}
              action={
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={backup}
                >
                  <Plus size={14} />
                  立即备份
                </button>
              }
            />
            <p className="muted">
              本地服务运行期间每小时检查，按用户保留最近 12
              份。恢复或永久删除前会先生成快照。
            </p>
            <div className="backup-list">
              {ws.backups.map((b, i) => (
                <div key={b.id}>
                  <span className="backup-icon">
                    <Archive size={18} />
                  </span>
                  <div>
                    <strong>
                      {dateOf(b.at)} ·{" "}
                      {new Date(b.at).toLocaleTimeString("zh-CN", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </strong>
                    <small>
                      {i === 0 ? "最新快照" : "历史快照"} · 完整结构
                    </small>
                  </div>
                  <button
                    className="text-button"
                    onClick={() =>
                      void api("backups/" + b.id)
                        .then((x) =>
                          download(
                            "沉淀-快照-" + b.at.slice(0, 10) + ".json",
                            JSON.stringify(x, null, 2),
                            "application/json",
                          ),
                        )
                        .catch((e) => notify(e.message))
                    }
                  >
                    <Download size={14} />
                    下载
                  </button>
                  <button
                    className="text-button"
                    onClick={() =>
                      dialog({
                        type: "confirm",
                        title: "恢复这一份快照",
                        message:
                          "你的自有内容与相关补充会恢复到此快照的状态。恢复前会备份当前状态，其他用户的个人空间保持独立。",
                        action: async () => {
                          await api("restore", { id: b.id });
                          await refresh();
                          notify("快照已恢复");
                        },
                      })
                    }
                  >
                    <RotateCcw size={14} />
                    恢复
                  </button>
                </div>
              ))}
            </div>
            {!ws.backups.length && (
              <div className="inline-empty">
                尚未生成快照。点击“立即备份”保存第一份。
              </div>
            )}
          </section>
        </>
      )}
      {tab === "trash" && (
        <>
          <div className="info-strip">
            <RotateCcw size={16} />
            回收站保留完整内容与补充。不会自动清空；永久删除前会生成备份。
          </div>
          <div className="trash-list">
            {deleted.map((n) => (
              <div key={n.id}>
                <span className="backup-icon">
                  {n.type === "topic" ? (
                    <Layers size={18} />
                  ) : (
                    <FileText size={18} />
                  )}
                </span>
                <div>
                  <strong>{titleOf(n)}</strong>
                  <small>
                    {kindLabel[n.type]} · {dateOf(n.deleted_at, true)}{" "}
                    移入回收站
                  </small>
                </div>
                <button
                  className="quiet-button"
                  onClick={() =>
                    void save({ ...n, deleted_at: null })
                      .then(() => notify("已恢复"))
                      .catch((e) => notify(e.message))
                  }
                >
                  <RotateCcw size={14} />
                  恢复
                </button>
                <IconButton
                  label="永久删除"
                  onClick={() =>
                    dialog({
                      type: "confirm",
                      title: "永久删除这条内容",
                      message:
                        "内容与其补充将从当前工作空间移除。操作前会生成完整备份，历史导出文件不会受影响。",
                      action: async () => {
                        await api("purge", { id: n.id });
                        await refresh();
                        notify("已永久删除，操作前快照已保留");
                      },
                    })
                  }
                >
                  <Trash2 size={16} />
                </IconButton>
              </div>
            ))}
          </div>
          {!deleted.length && (
            <Empty
              title="回收站是空的"
              description="被删除的记录和主题会先保留在这里。"
            />
          )}
        </>
      )}
      {tab === "members" && (
        <>
          {team ? (
            <>
              <div className="team-heading">
                <span className="workspace-avatar">
                  <Users size={23} />
                </span>
                <div>
                  <h2>{team.name}</h2>
                  <p>{team.description || "一起沉淀团队的经验与方法。"}</p>
                </div>
                {["owner", "admin"].includes(team.role) && (
                  <button
                    className="primary"
                    onClick={() => dialog({ type: "invite" })}
                  >
                    <UserPlus size={15} />
                    邀请成员
                  </button>
                )}
              </div>
              <div className="members-list">
                {members.map((m) => {
                  const profile = ws.profiles.find(
                    (p) => p.owner_id === m.account,
                  );
                  return (
                    <div key={m.account}>
                      <span className="user-avatar">
                        {(profile?.display_name || "?").slice(0, 1)}
                      </span>
                      <div>
                        <strong>
                          {profile?.display_name || "团队成员"}
                          {m.account === ws.me.owner_id && <small>你</small>}
                        </strong>
                        <p>
                          {m.role === "owner"
                            ? "维护空间与成员权限"
                            : m.role === "admin"
                              ? "邀请成员、维护团队知识"
                              : m.role === "editor"
                                ? "记录知识、发表补充"
                                : "阅读团队知识"}
                        </p>
                      </div>
                      {team.role === "owner" && m.role !== "owner" ? (
                        <select
                          aria-label={
                            "调整 " + profile?.display_name + " 的角色"
                          }
                          value={m.role}
                          onChange={(e) => {
                            const role = e.target.value;
                            dialog({
                              type: "confirm",
                              title:
                                role === "remove"
                                  ? "移除这位成员"
                                  : "调整成员角色",
                              message:
                                role === "remove"
                                  ? "成员将失去团队空间的访问权限；已有内容继续保留作者署名。"
                                  : "权限立即生效。个人知识空间与团队空间的内容保持隔离。",
                              action: async () => {
                                await api("members", {
                                  space,
                                  account: m.account,
                                  role,
                                });
                                await refresh();
                                notify("成员权限已更新");
                              },
                            });
                          }}
                        >
                          <option value="admin">管理员</option>
                          <option value="editor">编辑成员</option>
                          <option value="viewer">只读成员</option>
                          <option value="remove">移除成员</option>
                        </select>
                      ) : (
                        <span className="tag">{roleLabel(m.role)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="info-strip">
                <ShieldCheck size={16} />
                个人记录仅本人可见。团队成员只访问所在团队，正文由作者编辑；成员权限由服务端校验。
              </div>
            </>
          ) : (
            <Empty
              title="先打开一个团队空间"
              description="在左侧空间菜单切换团队，管理对应的成员与权限。"
              action={
                <button
                  className="quiet-button"
                  onClick={() => dialog({ type: "space" })}
                >
                  <Users size={15} />
                  创建团队空间
                </button>
              }
            />
          )}
        </>
      )}
      {tab === "platform" && <PlatformView />}
    </>
  );
}
