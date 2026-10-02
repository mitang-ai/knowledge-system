import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  BookOpen,
  Check,
  CheckCircle2,
  Clock3,
  Download,
  FileText,
  Layers,
  LayoutGrid,
  Leaf,
  Link2,
  List,
  MessageSquare,
  Paperclip,
  PenLine,
  Plus,
  Quote,
  Search,
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
  newItem,
  relative,
  reviewDue,
  titleOf,
} from "../lib";
import type { Attachment, Item, Kind, View } from "../types";

import {
  Body,
  Count,
  Empty,
  IconButton,
  PageHeading,
  SectionTitle,
} from "../ui";
import { labels, useWorkspace } from "../workspace";
import { useAI } from "../ai/context";
import { AITrigger } from "../ai/Provider";
export const templates = [
  {
    name: "自由记录",
    kind: "note" as Kind,
    description: "先留下想法，整理可以慢一点。",
    body: "",
  },
  {
    name: "阅读笔记",
    kind: "resource" as Kind,
    description: "保留出处，写下自己的理解。",
    body: "## 核心观点\n\n\n## 我的理解\n\n\n## 可以用在哪里\n\n",
  },
  {
    name: "可复用经验",
    kind: "experience" as Kind,
    description: "把一次实践，变成下一次的参考。",
    body: "## 适用场景\n\n\n## 具体做法\n\n\n## 边界与注意事项\n\n",
  },
  {
    name: "问题与探索",
    kind: "note" as Kind,
    description: "问题、假设与下一步验证。",
    body: "## 我想弄清的问题\n\n\n## 目前的判断\n\n\n## 下一步验证\n\n",
  },
];
export function Composer() {
  const { ws, space, topics, save, notify, canWrite, dialog } = useWorkspace();
  const { setDraft } = useAI();
  const key = "sediment-draft:" + ws.me.owner_id + ":" + space;
  const initial = useRef(
    (() => {
      const raw = localStorage.getItem(key) || "";
      try {
        const d = JSON.parse(raw);
        return {
          body: String(d.body || ""),
          ids: d.ids || [],
          kind: d.kind || "note",
          atts: d.atts || [],
        };
      } catch {
        return { body: raw, ids: [], kind: "note", atts: [] };
      }
    })(),
  );
  const [body, setBody] = useState<string>(initial.current.body),
    [ids, setIds] = useState<string[]>(initial.current.ids),
    [kind, setKind] = useState<Kind>(initial.current.kind),
    [atts, setAtts] = useState<Attachment[]>(initial.current.atts),
    [busy, setBusy] = useState(false),
    [topicMenu, setTopicMenu] = useState(false),
    [templateMenu, setTemplateMenu] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { setDraft(body); }, [body, setDraft]);
  useEffect(() => () => setDraft(""), [setDraft]);
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify({ body, ids, kind, atts }));
  }, [body, ids, kind, atts, key]);
  const submit = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      const item = newItem(kind, ws.me.owner_id, ws.me.display_name);
      await save({
        ...item,
        body: body.trim(),
        topic_ids: ids,
        atts,
        space_id: space || null,
        source: body.match(/https?:\/\/[^\s]+/)?.[0] || null,
      });
      setBody("");
      setIds([]);
      setAtts([]);
      notify("已记录。之后可以继续整理。");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const upload = async (files: FileList | null) => {
    if (!files) return;
    setBusy(true);
    try {
      const results: Attachment[] = [];
      for (const f of Array.from(files)) {
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
        results.push(value);
      }
      setAtts((a) => [...a, ...results]);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  };
  return (
    <div className="composer">
      <div className="composer-label">
        <PenLine size={15} />
        <span>快速记录</span>
        <span className="draft-label">
          {body ? "草稿已保存在此设备" : "不必想好标题"}
        </span>
      </div>
      <textarea
        id="quick-note"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={
          canWrite
            ? "此刻，有什么值得记下来？"
            : "当前成员角色为只读。"
        }
        disabled={!canWrite || busy}
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault();
            void upload(e.clipboardData.files);
          }
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {atts.length > 0 && (
        <div className="attachment-chips">
          {atts.map((a) => (
            <span key={a.id}>
              <Paperclip size={12} />
              {a.name}
              <button
                aria-label={"移除附件 " + a.name}
                onClick={() => setAtts(atts.filter((x) => x.id !== a.id))}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-toolbar">
        <AITrigger label="接着想" target={{title:"当前草稿",kind:"draft"}}/>
        <div className="composer-tools">
          <div className="menu-wrap">
            <button
              className="text-button"
              disabled={!canWrite}
              onClick={() => setTopicMenu((v) => !v)}
            >
              <Plus size={15} />
              {ids.length ? "已关联 " + ids.length + " 个主题" : "关联主题"}
            </button>
            {topicMenu && (
              <div className="popover topic-popover">
                <strong>将想法放进主题</strong>
                {topics.map((t) => (
                  <label key={t.id}>
                    <input
                      type="checkbox"
                      checked={ids.includes(t.id)}
                      onChange={() =>
                        setIds(
                          ids.includes(t.id)
                            ? ids.filter((x) => x !== t.id)
                            : [...ids, t.id],
                        )
                      }
                    />
                    {titleOf(t)}
                  </label>
                ))}
                {!topics.length && <small>先在主题空间创建主题</small>}
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
          <IconButton
            label="添加附件（最多 20 MB）"
            disabled={!canWrite || busy}
            onClick={() => file.current?.click()}
          >
            <Paperclip size={16} />
          </IconButton>
          <div className="menu-wrap">
            <IconButton
              label="选择记录模板"
              disabled={!canWrite}
              onClick={() => setTemplateMenu((v) => !v)}
            >
              <FileText size={16} />
            </IconButton>
            {templateMenu && (
              <div className="popover template-popover">
                {templates.map((t) => (
                  <button
                    key={t.name}
                    onClick={() => {
                      setTemplateMenu(false);
                      const apply = async () => {
                        setBody(t.body);
                        setKind(t.kind);
                      };
                      if (body.trim())
                        dialog({
                          type: "confirm",
                          title: "使用新的记录模板",
                          message:
                            "当前未提交的正文会替换为所选模板，已保存的记录保持完整。",
                          action: apply,
                        });
                      else void apply();
                    }}
                  >
                    <strong>{t.name}</strong>
                    <small>{t.description}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
          {kind !== "note" && <span className="tag">{kindLabel[kind]}</span>}
        </div>
        <div className="composer-submit">
          <span>⌘ / Ctrl ↵</span>
          <button
            className="primary"
            disabled={!body.trim() || busy || !canWrite}
            onClick={submit}
          >
            {busy ? "保存中…" : "记下来"}
            <ArrowRight size={15} />
          </button>
        </div>
      </div>
      <input
        ref={file}
        type="file"
        multiple
        hidden
        onChange={(e) => void upload(e.target.files)}
      />
    </div>
  );
}

export function HomeView() {
  const { ws, scoped, topics, go, open, topic, space, canWrite } = useWorkspace();
  const notes = scoped
    .filter((x) => x.type !== "topic" && active(x) && !x.archived)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const review = notes.filter(reviewDue).sort((a, b) =>
    (a.reviewed_at || a.created_at).localeCompare(b.reviewed_at || b.created_at),
  )[0];
  const und = notes.filter((x) => x.und).slice(0, 1);
  return (
    <>
      <PageHeading
        title={space ? "团队知识空间" : "我的知识空间"}
        description={`${notes.length} 条知识 · ${topics.length} 个主题 · ${notes.filter((x) => x.type === "experience").length} 条经验`}
        actions={
          <button className="primary" disabled={!canWrite} onClick={() => document.getElementById("quick-note")?.focus()}>
            <Plus size={15} />新建记录
          </button>
        }
      />
      <div className="desk-layout">
        <div className="desk-main">
          <Composer key={space + ws.me.owner_id} />
          <section className="recent-section">
            <SectionTitle
              title="最近更新"
              action={<button className="text-button" onClick={() => go(space ? "shared" : "library")}>查看全部<ArrowRight size={14} /></button>}
            />
            <NoteList items={notes.slice(0, 8)} showAuthor={!!space} />
            {!notes.length && <Empty title="从第一条记录开始" description="写一句话就够了，后面随时可以接着想。" />}
          </section>
        </div>
        <aside className="desk-aside">
          <section className="daily-review">
            <div className="margin-title"><Clock3 size={15} /><span>今天回顾</span></div>
            {review ? (
              <button className="review-feature" onClick={() => open(review.id)}>
                <Quote size={21} strokeWidth={1.25} />
                {review.title && <h3>{review.title}</h3>}
                <p>{review.body.slice(0, 145)}{review.body.length > 145 ? "…" : ""}</p>
                <div className="review-feature-bottom"><span>{dateOf(review.created_at, true)} 的记录</span><ArrowUpRight size={14} /></div>
              </button>
            ) : (
              <div className="review-all-done"><CheckCircle2 size={22} /><h3>这轮回顾完成了</h3><p>新理解已经留下，等下次再来看。</p></div>
            )}
            <button className="aside-link" onClick={() => go("review")}>进入回顾<ArrowRight size={14} /></button>
          </section>
          <section className="desk-topic-list">
            <div className="margin-title"><Layers size={14} /><span>常用主题</span></div>
            {topics.slice(0, 5).map((t) => (
              <button key={t.id} onClick={() => topic(t.id)}>
                <span className="topic-dot" /><span>{titleOf(t)}</span>
                <small>{notes.filter((x) => x.topic_ids.includes(t.id)).length}</small>
              </button>
            ))}
            <button className="aside-link" onClick={() => go("topics")}>{topics.length ? "查看所有主题" : "创建第一个主题"}<ArrowRight size={14} /></button>
          </section>
          {!!und.length && <section className="understanding-aside">
            <div className="margin-title"><Quote size={14} />理解在更新</div>
            {und.map((n) => <button key={n.id} onClick={() => open(n.id)}>
              <p>{ws.replies.find((r) => r.id === n.und)?.body.slice(0, 88) || titleOf(n)}</p>
              <span>来自 {titleOf(n).slice(0, 18)}<ArrowUpRight size={12} /></span>
            </button>)}
          </section>}
        </aside>
      </div>
    </>
  );
}

export function NoteList({
  items,
  grid = false,
  showAuthor = false,
}: {
  items: Item[];
  grid?: boolean;
  showAuthor?: boolean;
}) {
  const { topics, ws, open, save, notify } = useWorkspace();
  if (!grid) return (
    <div className={"knowledge-table " + (showAuthor ? "with-author" : "")}>
      <div className="knowledge-table-head" aria-hidden="true">
        <span>标题</span><span>主题</span>{showAuthor && <span>作者</span>}<span>最后更新</span><span />
      </div>
      {items.map((n) => {
        const linkedTopics = n.topic_ids.map((id) => topics.find((t) => t.id === id)).filter((t): t is Item => !!t);
        return <article className="note-row knowledge-table-row" key={n.id}>
          <button className="note-open" onClick={() => open(n.id)}>
            <span className="knowledge-title-cell">
              {n.type === "experience" ? <Leaf size={16} /> : n.type === "resource" ? <Link2 size={16} /> : <FileText size={16} />}
              <span>{titleOf(n)}</span>
            </span>
            <span className="knowledge-topic-cell">
              {linkedTopics.length ? <><span className="neutral-tag">{titleOf(linkedTopics[0])}</span>{linkedTopics.length > 1 && <small>+{linkedTopics.length - 1}</small>}</> : <span className="unfiled-label">待整理</span>}
            </span>
            {showAuthor && <span className="knowledge-author-cell">{ws.profiles.find((p) => p.owner_id === n.owner_id)?.display_name || n.owner_name}</span>}
            <span className="knowledge-date-cell">{relative(n.updated_at)}</span>
          </button>
          {n.owner_id === ws.me.owner_id && <IconButton
            label={n.starred ? "取消星标" : "加入星标"}
            className={"row-star " + (n.starred ? "is-starred" : "")}
            onClick={() => void save({ ...n, starred: !n.starred }).catch((e) => notify(e.message))}
          ><Bookmark size={15} fill={n.starred ? "currentColor" : "none"} /></IconButton>}
        </article>;
      })}
    </div>
  );
  return (
    <div className={grid ? "note-grid" : "note-list"}>
      {items.map((n) => {
        const replies = ws.replies.filter(
          (r) => r.item_id === n.id && active(r),
        );
        return (
          <article
            className={"note-row " + (grid ? "note-card" : "")}
            key={n.id}
          >
            <button className="note-open" onClick={() => open(n.id)}>
              <span className={"note-type-icon " + n.type}>
                {n.type === "experience" ? (
                  <Leaf size={17} />
                ) : n.type === "resource" ? (
                  <Link2 size={17} />
                ) : (
                  <FileText size={17} />
                )}
              </span>
              <div className="note-info">
                <h3>{titleOf(n)}</h3>
                {grid && <p>{n.body.slice(0, 130)}</p>}
                <div className="note-meta">
                  <span>{kindLabel[n.type]}</span>
                  {n.topic_ids.slice(0, 2).map((id) => {
                    const t =
                      topics.find((x) => x.id === id) ||
                      ws.items.find((x) => x.id === id);
                    return t ? (
                      <span className="inline-topic" key={id}>
                        <span
                          className="topic-dot"
                          style={{ background: colorOf(t) }}
                        />
                        {titleOf(t)}
                      </span>
                    ) : null;
                  })}
                  {!n.topic_ids.some((id) =>
                    topics.some((t) => t.id === id),
                  ) && <span className="inbox-meta">待整理</span>}
                  {showAuthor && (
                    <span>
                      {ws.profiles.find((p) => p.owner_id === n.owner_id)
                        ?.display_name || n.owner_name}
                    </span>
                  )}
                  {n.und && (
                    <span className="understanding-meta">
                      <Quote size={11} />
                      有新的理解
                    </span>
                  )}
                </div>
              </div>
              <div className="note-right">
                <span>{relative(n.created_at)}</span>
                {replies.length > 0 && (
                  <span>
                    <MessageSquare size={12} />
                    {replies.length}
                  </span>
                )}
              </div>
            </button>
            {n.owner_id === ws.me.owner_id && (
              <IconButton
                label={n.starred ? "取消星标" : "加入星标"}
                className={"row-star " + (n.starred ? "is-starred" : "")}
                onClick={() =>
                  void save({ ...n, starred: !n.starred }).catch((e) =>
                    notify(e.message),
                  )
                }
              >
                <Bookmark
                  size={15}
                  fill={n.starred ? "currentColor" : "none"}
                />
              </IconButton>
            )}
          </article>
        );
      })}
    </div>
  );
}

export function LibraryView({ view }: { view: View }) {
  const { scoped, topics, canWrite, go } = useWorkspace();
  const [query, setQuery] = useState(""),
    [kind, setKind] = useState("all"),
    [topic, setTopic] = useState("all"),
    [sort, setSort] = useState("new"),
    [grid, setGrid] = useState(false);
  let notes = scoped.filter(
    (x) => x.type !== "topic" && active(x) && !x.archived,
  );
  if (view === "inbox")
    notes = notes.filter(
      (x) => !x.topic_ids.some((id) => topics.some((t) => t.id === id)),
    );
  if (view === "experiences")
    notes = notes.filter((x) => x.type === "experience");
  if (view === "starred") notes = notes.filter((x) => x.starred);
  notes = notes
    .filter(
      (x) =>
        (kind === "all" || x.type === kind) &&
        (topic === "all" || x.topic_ids.includes(topic)) &&
        (!query ||
          (x.title + " " + x.body).toLowerCase().includes(query.toLowerCase())),
    )
    .sort((a, b) =>
      sort === "old"
        ? a.created_at.localeCompare(b.created_at)
        : sort === "updated"
          ? b.updated_at.localeCompare(a.updated_at)
          : b.created_at.localeCompare(a.created_at),
    );
  const descriptions: Partial<Record<View, string>> = {
    inbox: "先捕捉，再整理。为这些想法找到合适的主题。",
    library: "记录、资料与经验，都是你思考的一部分。",
    experiences: "把实践过的做法和判断，留给下一次使用。",
    starred: "留在手边的知识，随时回来接着想。",
    shared: "团队共同的记录与经验，每一条都保留作者与出处。",
  };
  return (
    <>
      <PageHeading
        title={labels[view]}
        eyebrow={
          view === "experiences"
            ? "从记录到复用"
            : view === "inbox"
              ? "整理，让想法有归处"
              : "你的知识集合"
        }
        description={descriptions[view]}
        actions={
          <button
            className="primary"
            onClick={() => go("home")}
            disabled={!canWrite}
          >
            <Plus size={16} />
            新建记录
          </button>
        }
      />
      <div className="collection-tools">
        <div className="filter-tabs">
          {(view === "experiences"
            ? ["all"]
            : ["all", "note", "resource", "experience"]
          ).map((k) => (
            <button
              key={k}
              className={kind === k ? "selected" : ""}
              onClick={() => setKind(k)}
            >
              {k === "all" ? "全部" : kindLabel[k as Kind]}
              {k === "all" && <Count>{notes.length}</Count>}
            </button>
          ))}
        </div>
        <div className="collection-controls">
          <div className="compact-search">
            <Search size={15} />
            <input
              aria-label="筛选当前列表"
              placeholder="筛选记录…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <select
            aria-label="按主题筛选"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          >
            <option value="all">所有主题</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {titleOf(t)}
              </option>
            ))}
          </select>
          <select
            aria-label="排序"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="new">最新记录</option>
            <option value="updated">最近更新</option>
            <option value="old">最早记录</option>
          </select>
          <IconButton
            label={grid ? "切换为列表" : "切换为卡片"}
            onClick={() => setGrid((v) => !v)}
          >
            {grid ? <List size={17} /> : <LayoutGrid size={17} />}
          </IconButton>
        </div>
      </div>
      {notes.length ? (
        <NoteList items={notes} grid={grid} showAuthor={view === "shared"} />
      ) : (
        <Empty
          title={
            query
              ? "没有找到相符的知识"
              : view === "inbox"
                ? "收件箱已经整理好了"
                : "这里还没有记录"
          }
          description={
            query
              ? "换一个关键词或清除筛选试试。"
              : "从个人书桌记录一个想法，之后随时回来完善。"
          }
        />
      )}
    </>
  );
}

export function TopicsView() {
  const { topics, scoped, topic, dialog, canWrite } = useWorkspace();
  const [q, setQ] = useState("");
  const shown = topics.filter((t) => titleOf(t).includes(q));
  return (
    <>
      <PageHeading
        title="主题空间"
        eyebrow="给知识建立联系"
        description="围绕长期关注的方向，组织不断生长的想法。"
        actions={
          <button
            className="primary"
            disabled={!canWrite}
            onClick={() => dialog({ type: "topic" })}
          >
            <Plus size={16} />
            新建主题
          </button>
        }
      />
      <div className="topics-bar">
        <span>{topics.length} 个主题 · 同一条记录可以连接多个主题</span>
        <div className="compact-search">
          <Search size={15} />
          <input
            aria-label="查找主题"
            placeholder="查找主题…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>
      <div className="topic-grid">
        {shown.map((t, i) => {
          const notes = scoped.filter(
            (x) => active(x) && x.topic_ids.includes(t.id),
          );
          return (
            <button
              key={t.id}
              className="topic-card"
              onClick={() => topic(t.id)}
              style={{ "--topic-color": colorOf(t, i) } as React.CSSProperties}
            >
              <div className="topic-cover">
                <div className={"topic-art art-" + (i % 3)}>
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <span className="topic-number">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <ArrowUpRight size={20} />
              </div>
              <div className="topic-card-body">
                <h2>{titleOf(t)}</h2>
                <p>{t.body || "写一句说明，为这个主题划定边界。"}</p>
                <div>
                  <span>{notes.length} 条知识</span>
                  <span>
                    {notes.filter((x) => x.type === "experience").length} 条经验
                  </span>
                  <span>{relative(t.updated_at)}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
      {!shown.length && (
        <Empty
          title="创建一个持续关注的主题"
          description="例如：产品设计、阅读与表达，或正在探索的问题。"
          action={
            <button
              className="quiet-button"
              onClick={() => dialog({ type: "topic" })}
            >
              <Plus size={14} />
              创建主题
            </button>
          }
        />
      )}
    </>
  );
}
export function TopicView({ id }: { id: string }) {
  const { topics, scoped, ws, dialog, go, open, save, notify } = useWorkspace();
  const [tab, setTab] = useState("notes");
  const t = topics.find((x) => x.id === id);
  if (!t)
    return (
      <Empty title="这个主题暂不可用" description="它可能已被移入回收站。" />
    );
  const notes = scoped.filter((x) => active(x) && x.topic_ids.includes(id));
  const comments = ws.replies
    .filter((r) => active(r) && notes.some((n) => n.id === r.item_id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return (
    <>
      <button className="back-link" onClick={() => go("topics")}>
        <ArrowLeft size={15} />
        所有主题
      </button>
      <PageHeading
        title={titleOf(t)}
        eyebrow="主题空间"
        description={t.body || "给这个主题补一句说明：它收什么内容？"}
        actions={
          <>
            {t.owner_id === ws.me.owner_id && (
              <button
                className="quiet-button"
                onClick={() => dialog({ type: "topic", item: t })}
              >
                <PenLine size={14} />
                编辑主题
              </button>
            )}
            <button
              className="quiet-button"
              onClick={() => {
                download(
                  titleOf(t) + ".md",
                  `# ${titleOf(t)}\n\n${t.body}\n\n` +
                    notes
                      .map((x) => markdown(x, ws.items, ws.replies))
                      .join("\n---\n\n"),
                );
                notify("主题已导出为 Markdown");
              }}
            >
              <Download size={15} />
              导出主题
            </button>
          </>
        }
      />
      <div className="topic-summary">
        <span>
          <BookOpen size={17} />
          <strong>{notes.length}</strong>条知识
        </span>
        <span>
          <MessageSquare size={17} />
          <strong>{comments.length}</strong>条补充
        </span>
        <span>
          <Leaf size={17} />
          <strong>{notes.filter((x) => x.type === "experience").length}</strong>
          条经验
        </span>
      </div>
      <div className="filter-tabs bordered-tabs">
        <button
          className={tab === "notes" ? "selected" : ""}
          onClick={() => setTab("notes")}
        >
          关联知识<Count>{notes.length}</Count>
        </button>
        <button
          className={tab === "replies" ? "selected" : ""}
          onClick={() => setTab("replies")}
        >
          补充与进展<Count>{comments.length}</Count>
        </button>
      </div>
      {tab === "notes" ? (
        <NoteList
          items={notes.sort((a, b) => b.updated_at.localeCompare(a.updated_at))}
        />
      ) : (
        <div className="topic-replies">
          {comments.map((r) => (
            <button key={r.id} onClick={() => open(r.item_id)}>
              <div>
                <span className="user-avatar small-avatar">
                  {r.owner_name.slice(0, 1)}
                </span>
                <strong>{r.owner_name}</strong>
                {r.is_progress && <span className="tag green-tag">进展</span>}
                <time>{dateOf(r.created_at, true)}</time>
              </div>
              <p>{r.body}</p>
              <small>
                <CornerLink />
                来自《{titleOf(notes.find((n) => n.id === r.item_id)!)}》
              </small>
            </button>
          ))}
        </div>
      )}
      {(tab === "notes" ? !notes.length : !comments.length) && (
        <Empty
          title={tab === "notes" ? "知识会在这里汇聚" : "继续想，也继续写"}
          description="打开记录后关联这个主题，补充与进展也会自动汇集到这里。"
        />
      )}
    </>
  );
}
export function CornerLink() {
  return <span className="corner-link">↳</span>;
}

export function ReviewView() {
  const { scoped, refresh, notify, open } = useWorkspace();
  const [done, setDone] = useState(0),
    [busy, setBusy] = useState(false);
  const notes = scoped
    .filter((x) => x.type !== "topic" && active(x) && reviewDue(x))
    .sort((a, b) =>
      (a.reviewed_at || a.created_at).localeCompare(
        b.reviewed_at || b.created_at,
      ),
    );
  const selected = notes[0];
  const update = async (interval: number, snooze = false) => {
    if (!selected) return;
    setBusy(true);
    try {
      await api("review", { item_id: selected.id, interval, snooze });
      await refresh();
      if (!snooze) setDone((d) => d + 1);
      notify(snooze ? "明天再回来看" : "已留下回顾记录");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeading
        title="与旧想法，再见一面"
        eyebrow="回顾"
        description="重读不是终点。补一句新理解，让知识继续向前。"
        actions={
          <span className="review-session-count">
            本轮已回顾 <strong>{done}</strong> 条
          </span>
        }
      />
      <div className="review-page-layout">
        <div className="review-page-main">
          {selected ? (
            <article className="review-reading">
              <div className="review-reading-meta">
                <span className="tag">{kindLabel[selected.type]}</span>
                <span>{dateOf(selected.created_at)} 记录</span>
                <span className="review-reason">
                  {selected.review_count
                    ? "到了约定的回顾时间"
                    : "还没有正式回顾过"}
                </span>
              </div>
              <h2>{titleOf(selected)}</h2>
              <AITrigger label="AI 追问" target={{title:titleOf(selected),itemId:selected.id}}/>
              <Body text={selected.body} />
              <div className="review-writing-link">
                <Quote size={17} />
                <div>
                  <strong>现在的你，会怎么理解？</strong>
                  <span>打开原文，补充你的新判断。</span>
                </div>
                <button
                  className="quiet-button"
                  onClick={() => open(selected.id)}
                >
                  补充理解
                  <ArrowUpRight size={15} />
                </button>
              </div>
              <div className="review-actions">
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => void update(1, true)}
                >
                  明天再看
                </button>
                <div>
                  <button
                    className="quiet-button"
                    disabled={busy}
                    onClick={() => void update(1)}
                  >
                    还要想想 · 1 天
                  </button>
                  <button
                    className="quiet-button"
                    disabled={busy}
                    onClick={() => void update(7)}
                  >
                    逐渐理解 · 7 天
                  </button>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => void update(30)}
                  >
                    已经掌握 · 30 天<Check size={15} />
                  </button>
                </div>
              </div>
            </article>
          ) : (
            <Empty
              title="这一轮，先到这里"
              description="待回顾的内容已经看完，下次到期会再出现。"
            />
          )}
        </div>
        <aside className="review-queue">
          <SectionTitle title="待回顾" count={notes.length} />
          {notes.slice(0, 8).map((n, i) => (
            <button
              key={n.id}
              onClick={() => open(n.id)}
              className={i === 0 ? "selected" : ""}
            >
              <span>{String(i + 1).padStart(2, "0")}</span>
              <div>
                <strong>{titleOf(n)}</strong>
                <small>
                  {n.reviewed_at
                    ? "上次回顾 " + dateOf(n.reviewed_at, true)
                    : dateOf(n.created_at, true) + " 留下的想法"}
                </small>
              </div>
            </button>
          ))}
          <p>
            回顾间隔由你选择。
            <br />
            内容不会因“看过”而自动消失。
          </p>
        </aside>
      </div>
    </>
  );
}
