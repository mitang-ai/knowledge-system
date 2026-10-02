import {
  AlertCircle,
  Archive,
  ArrowRight,
  Bookmark,
  Check,
  ChevronDown,
  Clock3,
  Download,
  History,
  Leaf,
  Link2,
  Paperclip,
  PenLine,
  Plus,
  Quote,
  RotateCcw,
  Trash2,
  X,
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
  newId,
  quoteText,
  stamp,
  titleOf,
} from "../lib";
import type { Attachment, Item, Reply, Version } from "../types";

import { Body, IconButton, Overlay, SafeLink, SectionTitle } from "../ui";
import { useWorkspace } from "../workspace";
import { AIOrigin } from "../ai/Origin";
import { AITrigger } from "../ai/Provider";
import { useAI } from "../ai/context";
import { readFile } from "../ai/reading";
import { safeAIError } from "../ai/client";
import { ExtractButton, ValidationCard, CitationButton } from "../connect/KnowledgeActions";
export function AttachmentList({ atts }: { atts: Attachment[] }) {
  const { notify } = useWorkspace();
  const ai = useAI();
  const [reading, setReading] = useState("");
  const controller = useRef<AbortController|null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const read = async (a: Attachment) => { const c = new AbortController(); controller.current = c; setReading(a.id); try { const response = await fetch("/api/files/" + a.id, {signal:c.signal}); if(!response.ok) throw new Error("missing"); const sources = await readFile(new File([await response.blob()], a.name, {type:a.mime}), c.signal); if(!c.signal.aborted) { ai.setExtraSources(sources); ai.open({title:a.name, kind:"reading", itemId:ai.target.itemId}, "summary"); } } catch(e) { notify(safeAIError(e)); } finally { setReading(""); } };
  return (
    <div className="attachment-list">
      {atts.map((a) => (
        <div key={a.id}>
          <Paperclip size={17} />
          <div>
            <strong>{a.name}</strong>
            <span>
              {(a.size / 1024).toFixed(0)} KB ·{" "}
              {a.local ? "本地附件" : "原文件未包含在交付包"}
            </span>
          </div>
          {a.local && <button className="text-button" disabled={!!reading} onClick={() => void read(a)}>{reading===a.id?"读取中…":"AI 阅读"}</button>}
          {a.local ? (
            <a
              className="icon-button"
              href={"/api/files/" + a.id}
              download={a.name}
              title="下载附件"
            >
              <Download size={16} />
            </a>
          ) : (
            <IconButton
              label="附件说明"
              onClick={() =>
                notify("保留了原云端附件路径。需要从原系统下载后重新上传。")
              }
            >
              <AlertCircle size={16} />
            </IconButton>
          )}
        </div>
      ))}
    </div>
  );
}

export function Detail({ item, close }: { item: Item; close: () => void }) {
  const { ws, topics, save, saveReply, notify, dialog, refresh } =
    useWorkspace();
  const canWrite =
    !item.space_id ||
    ws.spaces.find((s) => s.id === item.space_id)?.role !== "viewer";
  const mine = item.owner_id === ws.me.owner_id;
  const editable = mine && canWrite;
  const [editing, setEditing] = useState(false),
    [body, setBody] = useState(item.body),
    [title, setTitle] = useState(item.title),
    [reply, setReply] = useState(
      () =>
        localStorage.getItem(
          "sediment-reply:" + ws.me.owner_id + ":" + item.id,
        ) || "",
    ),
    [progress, setProgress] = useState(false),
    [quote, setQuote] = useState(""),
    [busy, setBusy] = useState(false),
    [topicMenu, setTopicMenu] = useState(false),
    [source, setSource] = useState(item.source || ""),
    [versions, setVersions] = useState<Version[] | null>(null),
    [replyAtts, setReplyAtts] = useState<Attachment[]>([]);
  const replyFile = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const comments = ws.replies
    .filter((r) => r.item_id === item.id && active(r))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const current = comments.find((r) => r.id === item.und);
  useEffect(() => {
    setEditing(false);
    setBody(item.body);
    setTitle(item.title);
    setSource(item.source || "");
    setReply(
      localStorage.getItem(
        "sediment-reply:" + ws.me.owner_id + ":" + item.id,
      ) || "",
    );
    setQuote("");
    setVersions(null);
    setReplyAtts([]);
  }, [item.id]);
  useEffect(() => {
    localStorage.setItem(
      "sediment-reply:" + ws.me.owner_id + ":" + item.id,
      reply,
    );
  }, [reply, item.id]);
  const update = async (value: Partial<Item>, message = "已更新") => {
    setBusy(true);
    try {
      await save({ ...item, ...value });
      notify(message);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!reply.trim()) return;
    setBusy(true);
    try {
      const comment: Reply = {
        id: newId(),
        item_id: item.id,
        owner_id: ws.me.owner_id,
        owner_name: ws.me.display_name,
        body: reply.trim(),
        is_progress: progress && mine,
        quote: quote || null,
        atts: replyAtts,
        created_at: stamp(),
      };
      await saveReply(comment);
      setReply("");
      setQuote("");
      setReplyAtts([]);
      setProgress(false);
      notify("补充已保存");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const setUnderstanding = async (r: Reply) => {
    await update(
      {
        und: r.id,
        und_hist: [...(item.und_hist || []), { r: r.id, t: Date.now() }],
      },
      "已更新当前理解，原理解保留在历史中",
    );
  };
  return (
    <Overlay title="知识详情" onClose={close} wide>
      <div className="detail-toolbar">
        <span className="tag">{kindLabel[item.type]}</span>
        <div>
          <ExtractButton items={[item]} />
          <AITrigger label="AI 分析" target={{title:titleOf(item),itemId:item.id}} mode="analysis"/>
          {editable && (
            <IconButton
              label={item.starred ? "取消星标" : "加入星标"}
              onClick={() => void update({ starred: !item.starred })}
            >
              <Bookmark
                size={17}
                fill={item.starred ? "currentColor" : "none"}
              />
            </IconButton>
          )}
          <details className="detail-export menu-wrap">
            <summary className="quiet-button">
              <Download size={15} />
              导出
              <ChevronDown size={12} />
            </summary>
            <div className="popover">
              <button
                onClick={() =>
                  download(
                    titleOf(item) + ".md",
                    markdown(item, ws.items, ws.replies),
                  )
                }
              >
                Markdown · 完整内容
              </button>
              <button
                onClick={() =>
                  download(
                    titleOf(item) + ".json",
                    JSON.stringify(
                      {
                        item,
                        topics: ws.items.filter((t) =>
                          item.topic_ids.includes(t.id),
                        ),
                        replies: comments,
                      },
                      null,
                      2,
                    ),
                    "application/json",
                  )
                }
              >
                JSON · 单条记录
              </button>
            </div>
          </details>
          {editable && (
            <IconButton
              label="编辑记录"
              onClick={() => {
                setBody(item.body);
                setTitle(item.title);
                setSource(item.source || "");
                setEditing((v) => !v);
              }}
              disabled={busy}
            >
              <PenLine size={16} />
            </IconButton>
          )}
          {editable && (
            <IconButton
              label="移入回收站"
              onClick={() =>
                dialog({
                  type: "confirm",
                  title: "移入回收站",
                  message: "记录和补充会保留。你可以在管理工作台恢复。",
                  action: async () => {
                    await save({ ...item, deleted_at: stamp() });
                    close();
                    notify("已移入回收站");
                  },
                })
              }
            >
              <Trash2 size={16} />
            </IconButton>
          )}
        </div>
      </div>
      <div className="detail-content" ref={contentRef}>
        {editing ? (
          <div className="edit-record">
            <label>
              标题 <span>可以留空</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="为这个想法起个名字"
              />
            </label>
            <label>
              正文
              <textarea
                autoFocus
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={11}
              />
            </label>
            <label>
              来源链接
              <input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="https://…"
              />
            </label>
            <div className="form-actions">
              <button
                className="quiet-button"
                onClick={() => setEditing(false)}
              >
                取消
              </button>
              <button
                className="primary"
                disabled={!body.trim() || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await save({
                      ...item,
                      title,
                      body,
                      source: source || null,
                      body_prev: item.body,
                      edited_body_at: stamp(),
                    });
                    setEditing(false);
                    notify("修改已保存，旧版本仍然保留");
                  } catch (e) {
                    notify((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                保存修改
                <Check size={15} />
              </button>
            </div>
          </div>
        ) : (
          <>
            <h1 className={"detail-title " + (!item.title ? "untitled-record" : "")}>
              {item.title || (editable ? (
                <button onClick={() => setEditing(true)}>添加标题 <PenLine size={15} /></button>
              ) : "无标题记录")}
            </h1>
            <div className="detail-meta">
              <span className="user-avatar small-avatar">
                {item.owner_name.slice(0, 1)}
              </span>
              <span>
                {ws.profiles.find((p) => p.owner_id === item.owner_id)
                  ?.display_name || item.owner_name}
              </span>
              <span>·</span>
              <span>{dateOf(item.created_at)}</span>
              <span className="detail-updated">
                {item.created_at !== item.updated_at
                  ? "更新于 " + dateOf(item.updated_at, true)
                  : ""}
              </span>
            </div>
          </>
        )}
        <div className="detail-topics">
          {item.topic_ids.map((id) => {
            const t = ws.items.find((x) => x.id === id && active(x));
            return t ? (
              <span className="tag" key={id}>
                <span
                  className="topic-dot"
                  style={{ background: colorOf(t) }}
                />
                {titleOf(t)}
              </span>
            ) : null;
          })}
          {editable && (
            <div className="menu-wrap">
              <button
                className="text-button"
                onClick={() => setTopicMenu((v) => !v)}
              >
                <Plus size={13} />
                关联主题
              </button>
              {topicMenu && (
                <div className="popover topic-popover">
                  {ws.items
                    .filter(
                      (t) =>
                        t.type === "topic" &&
                        active(t) &&
                        (t.space_id || "") === (item.space_id || ""),
                    )
                    .map((t) => (
                      <label key={t.id}>
                        <input
                          type="checkbox"
                          disabled={busy}
                          checked={item.topic_ids.includes(t.id)}
                          onChange={() =>
                            void update({
                              topic_ids: item.topic_ids.includes(t.id)
                                ? item.topic_ids.filter((x) => x !== t.id)
                                : [...item.topic_ids, t.id],
                            })
                          }
                        />
                        {titleOf(t)}
                      </label>
                    ))}
                  <button
                    className="text-button"
                    onClick={() => setTopicMenu(false)}
                  >
                    完成
                    <Check size={14} />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        {item.source && (
          <div className="source-line">
            <Link2 size={14} />
            <SafeLink href={item.source}>{item.source}</SafeLink>
            <span>仅保留来源链接</span>
          </div>
        )}
        {current && (
          <section className="current-understanding">
            <div>
              <Quote size={16} />
              <strong>我现在的理解</strong>
              <span>{dateOf(current.created_at, true)}</span>
            </div>
            <Body text={current.body} />
            <details>
              <summary>理解的变化 · {item.und_hist?.length || 1} 次</summary>
              {(item.und_hist || [])
                .slice()
                .reverse()
                .map((h, i) => (
                  <p key={h.t + "-" + i}>
                    <time>{dateOf(new Date(h.t).toISOString(), true)}</time>
                    {comments.find((r) => r.id === h.r)?.body || "该补充已删除"}
                  </p>
                ))}
            </details>
          </section>
        )}
        {!editing && (
          <div className="record-body">
            <Body text={item.body} />
          </div>
        )}
        <AIOrigin value={item.ai} />
        {item.atts?.length > 0 && <AttachmentList atts={item.atts} />}
        <div className="record-actions">
          {editable && item.type !== "experience" && (
            <button
              className="quiet-button"
              disabled={busy}
              onClick={() =>
                dialog({
                  type: "confirm",
                  title: "提炼为可复用经验",
                  message:
                    "这条记录会收录到经验手册。原始内容、主题、补充与版本都会保留；之后可以继续编辑适用场景与做法。",
                  action: async () => {
                    await save({
                      ...item,
                      type: "experience",
                      exp_st: "需要再确认",
                      exp_src: item.id,
                    });
                    notify("已收录到经验手册");
                  },
                })
              }
            >
              <Leaf size={15} />
              收录为经验
            </button>
          )}
          {item.type === "experience" && <ValidationCard item={item}/>}
          <CitationButton item={item}/>
          {item.type === "experience" && editable && (
            <label className="experience-status">
              个人态度
              <select
                value={item.exp_st || "需要再确认"}
                onChange={(e) => void update({ exp_st: e.target.value })}
              >
                <option>需要再确认</option>
                <option>我认同</option>
                <option>我尝试过</option>
                <option>暂时采用</option>
              </select>
            </label>
          )}
          <button
            className="text-button"
            onClick={() =>
              void api<Version[]>("versions/" + item.id)
                .then(setVersions)
                .catch((e) => notify(e.message))
            }
          >
            <History size={15} />
            版本历史
          </button>
          {editable && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                void update(
                  { archived: !item.archived },
                  item.archived ? "已取消归档" : "已归档，可在管理工作台查看",
                )
              }
            >
              <Archive size={14} />
              {item.archived ? "取消归档" : "归档记录"}
            </button>
          )}
          {
            <details className="review-options">
              <summary className="text-button">
                <Clock3 size={14} />
                回顾设置
              </summary>
              <label>
                <input
                  type="checkbox"
                  checked={!!item.no_review}
                  onChange={(e) =>
                    void api("review", {
                      item_id: item.id,
                      no_review: e.target.checked,
                    })
                      .then(refresh)
                      .catch((error) => notify(error.message))
                  }
                />
                暂不参与回顾
              </label>
              <span>
                下次回顾：
                {item.review_due ? dateOf(item.review_due) : "尚未安排"}
              </span>
            </details>
          }
        </div>
        {versions && (
          <section className="version-list">
            <SectionTitle
              title="编辑历史"
              count={versions.length}
              action={
                <IconButton label="收起历史" onClick={() => setVersions(null)}>
                  <X size={15} />
                </IconButton>
              }
            />
            {versions.length ? (
              versions.map((v) => (
                <details key={v.id}>
                  <summary>
                    {dateOf(v.at)} ·{" "}
                    {new Date(v.at).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    <span>
                      {kindLabel[v.item.type]} · {v.item.body.length} 字
                    </span>
                  </summary>
                  <Body text={v.item.body} />
                  {editable && (
                    <button
                      className="quiet-button"
                      onClick={() =>
                        dialog({
                          type: "confirm",
                          title: "恢复这个版本",
                          message:
                            "当前内容会先保留为新版本，再恢复所选版本的标题与正文。",
                          action: async () => {
                            await save({
                              ...item,
                              title: v.item.title,
                              body: v.item.body,
                            });
                            setVersions(null);
                            notify("已恢复所选版本");
                          },
                        })
                      }
                    >
                      <RotateCcw size={13} />
                      恢复标题与正文
                    </button>
                  )}
                </details>
              ))
            ) : (
              <p className="muted">首次修改后，这里会保留之前的版本。</p>
            )}
          </section>
        )}
        <section className="replies-section">
          <SectionTitle title="接着想，继续写" count={comments.length} />
          <div className="reply-timeline">
            {comments.map((r) => (
              <article className="reply" key={r.id}>
                <span className="user-avatar small-avatar">
                  {r.owner_name.slice(0, 1)}
                </span>
                <div>
                  <div className="reply-meta">
                    <strong>{r.owner_name}</strong>
                    <time>{dateOf(r.created_at, true)}</time>
                    {r.is_progress && (
                      <span className="tag green-tag">进展</span>
                    )}
                    {item.und === r.id && (
                      <span className="tag green-tag">当前理解</span>
                    )}
                  </div>
                  {quoteText(r.quote) && (
                    <blockquote>{quoteText(r.quote)}</blockquote>
                  )}
                  <Body text={r.body} />
                  <AIOrigin value={r.ai} />
                  {r.atts?.length > 0 && <AttachmentList atts={r.atts} />}
                  <div className="reply-actions">
                    <button
                      onClick={() => {
                        setQuote(r.body);
                        document.getElementById("reply-input")?.focus();
                      }}
                    >
                      <Quote size={12} />
                      引用
                    </button>
                    {mine && item.und !== r.id && (
                      <button
                        disabled={busy}
                        onClick={() => void setUnderstanding(r)}
                      >
                        <Check size={12} />
                        设为当前理解
                      </button>
                    )}
                    {r.owner_id === ws.me.owner_id && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          dialog({
                            type: "confirm",
                            title: "删除这条补充",
                            message:
                              item.und === r.id
                                ? "这也是当前理解。删除后会同时取消当前理解。"
                                : "补充会被标记为已删除，原文保持完整。",
                            action: async () => {
                              await saveReply({ ...r, deleted_at: stamp() });
                              if (item.und === r.id)
                                await save({ ...item, und: null });
                              notify("补充已删除");
                            },
                          })
                        }
                      >
                        <Trash2 size={12} />
                        删除
                      </button>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
          {!item.deleted_at && canWrite && (
            <div className="reply-composer">
              {quote && (
                <div className="quote-preview">
                  <Quote size={13} />
                  <span>{quote.slice(0, 100)}</span>
                  <IconButton label="取消引用" onClick={() => setQuote("")}>
                    <X size={13} />
                  </IconButton>
                </div>
              )}
              <textarea
                id="reply-input"
                placeholder="你现在有什么新的理解？"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
              {replyAtts.length > 0 && (
                <div className="attachment-chips">
                  {replyAtts.map((a) => (
                    <span key={a.id}>
                      {a.name}
                      <button
                        onClick={() =>
                          setReplyAtts(replyAtts.filter((x) => x.id !== a.id))
                        }
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div>
                <div className="reply-composer-tools">
                  <IconButton
                    label="引用选中的原文"
                    onClick={() => {
                      const selection = window.getSelection();
                      if (
                        selection &&
                        contentRef.current?.contains(selection.anchorNode) &&
                        selection.toString().trim()
                      ) {
                        setQuote(selection.toString());
                        document.getElementById("reply-input")?.focus();
                      } else notify("先在原文或补充中选中一段文字");
                    }}
                  >
                    <Quote size={15} />
                  </IconButton>
                  <IconButton
                    label="为补充添加附件"
                    disabled={busy}
                    onClick={() => replyFile.current?.click()}
                  >
                    <Paperclip size={15} />
                  </IconButton>
                  {editable && (
                    <label>
                      <input
                        type="checkbox"
                        checked={progress}
                        onChange={(e) => setProgress(e.target.checked)}
                      />
                      记为进展
                    </label>
                  )}
                </div>
                <button
                  className="primary"
                  disabled={!reply.trim() || busy}
                  onClick={() => void submit()}
                >
                  保存补充
                  <ArrowRight size={14} />
                </button>
              </div>
              <input
                hidden
                ref={replyFile}
                type="file"
                multiple
                onChange={async (e) => {
                  setBusy(true);
                  try {
                    const additions: Attachment[] = [];
                    for (const f of Array.from(e.target.files || [])) {
                      const response = await fetch("/api/files", {
                        method: "POST",
                        headers: {
                          "Content-Type": f.type || "application/octet-stream",
                          "X-File-Name": encodeURIComponent(f.name),
                        },
                        body: f,
                      });
                      const value = await response.json();
                      if (!response.ok) throw new Error(value.error);
                      additions.push(value);
                    }
                    setReplyAtts((a) => [...a, ...additions]);
                  } catch (e) {
                    notify((e as Error).message);
                  } finally {
                    setBusy(false);
                    e.target.value = "";
                  }
                }}
              />
            </div>
          )}
        </section>
      </div>
    </Overlay>
  );
}
