import {
  Bookmark,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Home,
  Inbox,
  Layers,
  Leaf,
  Menu,
  Plus,
  Search,
  Paperclip,
  Settings2,
  SlidersHorizontal,
  Type,
  UserPlus,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { BrandMark } from "./Brand";
import { ThemeToggle } from "./ThemeToggle";
import {
  active,
  api,
  colorOf,
  defaultPrefs,
  fonts,
  loadFont,
  reviewDue,
  titleOf,
} from "./lib";
import type { Item, Preferences, Reply, View, Workspace } from "./types";

import { Count, IconButton } from "./ui";
import { Login } from "./views/Auth";
import { Detail } from "./views/Detail";
import { DialogView } from "./views/Dialogs";
import {
  HomeView,
  LibraryView,
  ReviewView,
  TopicsView,
  TopicView,
} from "./views/Knowledge";
import { ManageView } from "./views/Management";
import { SearchDialog } from "./views/Search";
import { AIProvider, AITrigger } from "./ai/Provider";
import { ReadingView } from "./ai/Reading";
import { SettingsView } from "./views/Settings";
import { Context, labels, type ContextValue, type Dialog } from "./workspace";
const nav = [
  { id: "home", icon: Home },
  { id: "reading", icon: Paperclip },
  { id: "inbox", icon: Inbox },
  { id: "library", icon: BookOpen },
  { id: "topics", icon: Layers },
  { id: "review", icon: Clock3 },
  { id: "experiences", icon: Leaf },
  { id: "starred", icon: Bookmark },
] as const;

export default function App() {
  const [ws, setWs] = useState<Workspace | null>(null),
    [error, setError] = useState(""),
    [login, setLogin] = useState(false);
  const [view, setView] = useState<View>("home"),
    [space, setSpace] = useState(""),
    [selectedTopic, setSelectedTopic] = useState(""),
    [detail, setDetail] = useState(""),
    [search, setSearch] = useState(false),
    [dialog, setDialog] = useState<Dialog>(null),
    [mobile, setMobile] = useState(false),
    [spaceMenu, setSpaceMenu] = useState(false),
    [toast, setToast] = useState("");
  const [aiReturn, setAIReturn] = useState<{view:View;topic:string;detail:string}|null>(null);
  const [settingsTab, setSettingsTab] = useState("type");
  const [prefs, setPrefs] = useState<Preferences>(() => {
    let theme = defaultPrefs.theme;
    try {
      const saved = localStorage.getItem("sediment-theme");
      if (saved === "light" || saved === "dark" || saved === "system") theme = saved;
    } catch { /* Storage can be unavailable in a restricted browser. */ }
    return { ...defaultPrefs, theme };
  });
  const notify = (text: string) => setToast(text);
  const refresh = async () => {
    try {
      const value = await api<Workspace>("state");
      setWs(value);
      setLogin(false);
      setError("");
      setPrefs({ ...defaultPrefs, ...value.preferences });
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes("登录")) {
        setLogin(true);
        setWs(null);
      } else setError(message);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    loadFont("noto-sans-sc");
    loadFont("noto-serif-sc");
    loadFont(prefs.font);
    const family =
      fonts.find((f) => f.id === prefs.font)?.family || "Noto Sans SC";
    const root = document.documentElement;
    root.style.setProperty(
      "--reading-font",
      `"${family}","Noto Sans SC",sans-serif`,
    );
    root.style.setProperty("--reading-size", prefs.size + "px");
    root.style.setProperty("--ui-size", prefs.uiSize + "px");
    root.style.setProperty("--heading-size", prefs.headingSize + "px");
    root.style.setProperty("--reading-height", String(prefs.lineHeight));
    root.style.setProperty("--reading-width", prefs.width + "px");
    root.dataset.theme = prefs.theme;
    root.dataset.density = prefs.density;
    root.dataset.motion = prefs.motion ? "full" : "reduced";
    root.dataset.accent = prefs.accent;
    try { localStorage.setItem("sediment-theme", prefs.theme); } catch { /* Optional cache. */ }
  }, [prefs]);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const input = (e.target as HTMLElement).closest(
        "input,textarea,select,[contenteditable]",
      );
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearch((v) => !v);
      }
      if (e.key === "Escape") {
        setSearch(false);
        setDialog(null);
        setDetail("");
        setMobile(false);
      }
      if (!input && !e.metaKey && !e.ctrlKey && e.key === "n") {
        e.preventDefault();
        setView("home");
        setTimeout(() => document.getElementById("quick-note")?.focus(), 50);
      }
    };
    document.addEventListener("keydown", fn);
    return () => document.removeEventListener("keydown", fn);
  }, []);
  const save = async (item: Item) => {
    const result = await api<Item>("items", item);
    setWs((old) =>
      old
        ? {
            ...old,
            items: old.items.some((x) => x.id === result.id)
              ? old.items.map((x) => (x.id === result.id ? result : x))
              : [...old.items, result],
          }
        : old,
    );
    return result;
  };
  const saveReply = async (reply: Reply) => {
    const result = await api<Reply>("replies", reply);
    setWs((old) =>
      old
        ? {
            ...old,
            replies: old.replies.some((x) => x.id === result.id)
              ? old.replies.map((x) => (x.id === result.id ? result : x))
              : [...old.replies, result],
          }
        : old,
    );
    return result;
  };
  const go = (v: View) => {
    setView(v);
    setSelectedTopic("");
    setMobile(false);
  };
  const chooseTopic = (id: string) => {
    setSelectedTopic(id);
    setView("topics");
    setMobile(false);
  };
  const settings = (value: Preferences) => {
    setPrefs(value);
    if (ws) void api("preferences", value).catch((e) => notify(e.message));
  };
  const themeControl = <ThemeToggle theme={prefs.theme} onChange={(theme) => settings({ ...prefs, theme })} />;
  if (login) return <>{themeControl}<Login onSuccess={refresh} /></>;
  if (!ws)
    return (
      <>
      {themeControl}
      <div className="loading-screen">
        <BrandMark />
        <h2>沉淀</h2>
        <p>{error || "正在打开你的知识空间…"}</p>
        {error && (
          <button className="primary" onClick={refresh}>
            重新连接
          </button>
        )}
        <small>本地服务启动命令：python server/app.py</small>
      </div>
      </>
    );
  const scoped = ws.items.filter((x) => (x.space_id || "") === space),
    topics = scoped.filter((x) => x.type === "topic" && active(x)),
    notes = scoped.filter(
      (x) => x.type !== "topic" && active(x) && !x.archived,
    ),
    inbox = notes.filter(
      (x) => !x.topic_ids.some((id) => topics.some((t) => t.id === id)),
    ),
    due = notes.filter(reviewDue),
    currentSpace = ws.spaces.find((x) => x.id === space),
    canWrite = !currentSpace || currentSpace.role !== "viewer";
  const context: ContextValue = {
    ws,
    prefs,
    space,
    scoped,
    topics,
    save,
    saveReply,
    refresh,
    notify,
    open: setDetail,
    go,
    dialog: setDialog,
    topic: chooseTopic,
    settings,
    canWrite,
  };
  const openItem = ws.items.find((x) => x.id === detail);
  const switchSpace = (id: string) => {
    setSpace(id);
    setView(id ? "shared" : "home");
    setSelectedTopic("");
    setSpaceMenu(false);
  };
  return (
    <Context.Provider value={context}>
      <AIProvider key={ws.me.owner_id + ":" + space} page={view} topicId={selectedTopic} detailId={detail} returnToWork={aiReturn ? () => { setView(aiReturn.view); setSelectedTopic(aiReturn.topic); setDetail(aiReturn.detail); setAIReturn(null); } : undefined} openSettings={() => { if(view!=="settings") setAIReturn({view,topic:selectedTopic,detail}); setView("settings"); setSettingsTab("ai"); setDetail(""); }}>
      <div className="app-shell">
        {themeControl}
        {mobile && (
          <div className="mobile-shade" onClick={() => setMobile(false)} />
        )}
        <aside className={"sidebar " + (mobile ? "mobile-open" : "")}>
          <div className="sidebar-brand">
            <BrandMark />
            <span>沉淀</span>
          </div>
          <div className="space-switcher">
            <button
              onClick={() => setSpaceMenu((v) => !v)}
              aria-expanded={spaceMenu}
            >
              <span className="workspace-avatar">
                {currentSpace ? (
                  <Users size={18} />
                ) : (
                  ws.me.display_name.slice(0, 1)
                )}
              </span>
              <span>
                <strong>{currentSpace?.name || "个人知识空间"}</strong>
                <small>{currentSpace ? "团队空间" : "只属于你的思考"}</small>
              </span>
              <ChevronDown size={15} />
            </button>
            {spaceMenu && (
              <div className="space-menu">
                <button onClick={() => switchSpace("")}>
                  <Home size={16} />
                  个人知识空间{!space && <Check size={15} />}
                </button>
                {ws.spaces.map((s) => (
                  <button key={s.id} onClick={() => switchSpace(s.id)}>
                    <Users size={16} />
                    {s.name}
                    {space === s.id && <Check size={15} />}
                  </button>
                ))}
                <hr />
                <button
                  onClick={() => {
                    setDialog({ type: "space" });
                    setSpaceMenu(false);
                  }}
                >
                  <Plus size={16} />
                  创建团队空间
                </button>
                <button
                  onClick={() => {
                    setDialog({ type: "join" });
                    setSpaceMenu(false);
                  }}
                >
                  <UserPlus size={16} />
                  加入团队空间
                </button>
              </div>
            )}
          </div>
          <button className="sidebar-search" onClick={() => setSearch(true)}>
            <Search size={16} />
            <span>搜索知识</span>
            <kbd>⌘ K</kbd>
          </button>
          <nav aria-label="主导航">
            {nav.map(({ id, icon: Icon }) => (
              <button
                key={id}
                className={"nav-item " + (view === id ? "selected" : "")}
                onClick={() => go(id)}
              >
                <Icon size={18} strokeWidth={1.65} />
                <span>{id === "home" && space ? "团队书桌" : labels[id]}</span>
                {id === "inbox" && inbox.length > 0 && (
                  <Count>{inbox.length}</Count>
                )}
                {id === "review" && due.length > 0 && (
                  <span className="nav-dot" />
                )}
              </button>
            ))}
            {space && (
              <button
                className={"nav-item " + (view === "shared" ? "selected" : "")}
                onClick={() => go("shared")}
              >
                <Users size={18} />
                <span>团队知识</span>
              </button>
            )}
          </nav>
          <div className="sidebar-section-label">
            <span>我的主题</span>
            <IconButton
              label="新建主题"
              onClick={() => setDialog({ type: "topic" })}
              disabled={!canWrite}
            >
              <Plus size={14} />
            </IconButton>
          </div>
          <div className="sidebar-topics">
            {topics.slice(0, 7).map((t, i) => (
              <button
                key={t.id}
                className={selectedTopic === t.id ? "selected" : ""}
                onClick={() => chooseTopic(t.id)}
              >
                <span
                  className="topic-dot"
                  style={{ background: colorOf(t, i) }}
                />
                <span>{titleOf(t)}</span>
              </button>
            ))}
            {topics.length > 7 && (
              <button className="more-topics" onClick={() => go("topics")}>
                查看全部 {topics.length} 个主题
                <ChevronRight size={12} />
              </button>
            )}
            {!topics.length && (
              <button
                className="more-topics"
                onClick={() => setDialog({ type: "topic" })}
              >
                创建第一个主题
                <Plus size={13} />
              </button>
            )}
          </div>
          <div className="sidebar-bottom">
            <button
              className={"nav-item " + (view === "manage" ? "selected" : "")}
              onClick={() => go("manage")}
            >
              <SlidersHorizontal size={17} />
              <span>管理工作台</span>
            </button>
            <button
              className={"nav-item " + (view === "settings" ? "selected" : "")}
              onClick={() => go("settings")}
            >
              <Settings2 size={17} />
              <span>偏好设置</span>
            </button>
            <div className="sidebar-user">
              <button onClick={() => go("settings")}>
                <span className="user-avatar">
                  {ws.me.display_name.slice(0, 1)}
                </span>
                <span>
                  <strong>{ws.me.display_name}</strong>
                  <small>
                    <span className="status-dot" />
                    本地数据已连接
                  </small>
                </span>
              </button>
              <IconButton
                label="快捷键"
                onClick={() => setDialog({ type: "shortcuts" })}
              >
                <CircleHelp size={16} />
              </IconButton>
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumb">
              <IconButton
                label="打开导航"
                className="mobile-menu"
                onClick={() => setMobile((v) => !v)}
              >
                <Menu size={19} />
              </IconButton>
              <span>{currentSpace?.name || "个人空间"}</span>
              <ChevronRight size={13} />
              <strong>
                {selectedTopic
                  ? topics.find((x) => x.id === selectedTopic)?.title
                  : labels[view]}
              </strong>
            </div>
            <div className="topbar-actions">
              <AITrigger />
              <IconButton label="全局搜索" onClick={() => setSearch(true)}>
                <Search size={18} />
              </IconButton>
              <IconButton label="阅读与排版" onClick={() => go("settings")}>
                <Type size={18} />
              </IconButton>
            </div>
          </header>
          <main
            className={
              "main-content " +
              (view === "settings" || view === "manage" ? "wide-content" : "")
            }
          >
            {view === "home" ? (
              <HomeView />
            ) : view === "topics" ? (
              selectedTopic ? (
                <TopicView id={selectedTopic} />
              ) : (
                <TopicsView />
              )
            ) : view === "review" ? (
              <ReviewView />
            ) : view === "reading" ? (
              <ReadingView />
            ) : view === "settings" ? (
              <SettingsView initialTab={settingsTab} />
            ) : view === "manage" ? (
              <ManageView />
            ) : (
              <LibraryView view={view} />
            )}
          </main>
          <footer className="page-footer">
            <span>留下一点想法，建立一点联系。</span>
            <span>
              沉淀 <span className="footer-dot">·</span> v4.2
            </span>
          </footer>
        </div>
        {openItem && <Detail item={openItem} close={() => setDetail("")} />}{" "}
        {search && <SearchDialog close={() => setSearch(false)} />}{" "}
        {dialog && <DialogView dialog={dialog} close={() => setDialog(null)} />}{" "}
        {toast && (
          <div className="toast" role="status">
            <CheckCircle2 size={17} />
            {toast}
          </div>
        )}
      </div>
      </AIProvider>
    </Context.Provider>
  );
}
