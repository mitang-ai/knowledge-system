import type { Item, Kind, Preferences, Reply } from "./types";
export const defaultPrefs: Preferences = {
  font: "noto-sans-sc",
  size: 17,
  uiSize: 14,
  headingSize: 32,
  lineHeight: 1.9,
  width: 720,
  theme: "light",
  density: "comfortable",
  motion: true,
  accent: "graphite",
};
export const fonts = [
  {
    id: "noto-sans-sc",
    name: "思源黑体",
    family: "Noto Sans SC",
    kind: "清晰 · 现代中文",
    sample: "让每一个想法，有迹可循。",
  },
  {
    id: "noto-serif-sc",
    name: "思源宋体",
    family: "Noto Serif SC",
    kind: "沉静 · 长文阅读",
    sample: "让每一个想法，有迹可循。",
  },
  {
    id: "lxgw-wenkai-tc",
    name: "霞鹜文楷",
    family: "LXGW WenKai TC",
    kind: "温润 · 手写气息",
    sample: "让每一个想法，有迹可循。",
  },
  {
    id: "lxgw-wenkai-mono-tc",
    name: "霞鹜文楷等宽",
    family: "LXGW WenKai Mono TC",
    kind: "整齐 · 笔记与代码",
    sample: "让每一个想法，有迹可循。",
  },
  {
    id: "zcool-xiaowei",
    name: "站酷小薇体",
    family: "ZCOOL XiaoWei",
    kind: "书卷 · 中文标题",
    sample: "让每一个想法，有迹可循。",
  },
  {
    id: "zcool-qingke-huangyou",
    name: "站酷庆科黄油体",
    family: "ZCOOL QingKe HuangYou",
    kind: "圆润 · 轻松书写",
    sample: "让每一个想法，有迹可循。",
  },
  {
    id: "inter",
    name: "Inter",
    family: "Inter",
    kind: "简洁 · 拉丁文字",
    sample: "A place for your thoughts.",
  },
  {
    id: "ibm-plex-sans",
    name: "IBM Plex Sans",
    family: "IBM Plex Sans",
    kind: "人文 · 拉丁文字",
    sample: "A place for your thoughts.",
  },
  {
    id: "source-sans-3",
    name: "Source Sans 3",
    family: "Source Sans 3",
    kind: "通透 · 拉丁文字",
    sample: "A place for your thoughts.",
  },
  {
    id: "literata",
    name: "Literata",
    family: "Literata",
    kind: "典雅 · 拉丁长文",
    sample: "A place for your thoughts.",
  },
];
export function loadFont(id: string) {
  if (!fonts.some((f) => f.id === id)) return;
  if (document.getElementById("font-" + id)) return;
  const link = document.createElement("link");
  link.id = "font-" + id;
  link.rel = "stylesheet";
  link.href = "/fonts/" + id + "/400.css";
  document.head.appendChild(link);
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    "/api/" + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "操作未完成");
  return value as T;
}
export const newId = () => crypto.randomUUID().replaceAll("-", "");
export const stamp = () => new Date().toISOString();
export const titleOf = (x: Item) =>
  x.title.trim() ||
  x.body
    .trim()
    .split("\n")[0]
    .replace(/^#+\s*/, "")
    .slice(0, 66) ||
  "未命名记录";
export const kindLabel: Record<Kind, string> = {
  note: "记录",
  topic: "主题",
  experience: "经验",
  resource: "资料",
};
export function dateOf(value: string | undefined | null, short = false) {
  if (!value) return "尚未回看";
  const date = new Date(value);
  return Number.isNaN(+date)
    ? "日期未知"
    : date.toLocaleDateString(
        "zh-CN",
        short
          ? { month: "numeric", day: "numeric" }
          : { year: "numeric", month: "long", day: "numeric" },
      );
}
export function relative(value: string) {
  const days = Math.floor((Date.now() - +new Date(value)) / 86400000);
  if (days < 1) return "今天";
  if (days === 1) return "昨天";
  if (days < 7) return days + " 天前";
  return dateOf(value, true);
}
export const active = (x: Item | Reply) => !x.deleted_at;
export const colors = [
  "#555555",
  "#777777",
  "#999999",
  "#666666",
  "#aaaaaa",
  "#888888",
];
export function colorOf(x: Item, index = 0) {
  // Preserve imported color metadata; the monochrome UI uses neutral markers.
  return colors.includes(x.color || "") ? x.color! : colors[index % colors.length];
}
export function newItem(type: Kind, owner: string, name: string): Item {
  return {
    id: newId(),
    type,
    owner_id: owner,
    owner_name: name,
    title: "",
    body: "",
    topic_ids: [],
    atts: [],
    created_at: stamp(),
    updated_at: stamp(),
  };
}
export function download(
  name: string,
  content: string,
  mime = "text/plain;charset=utf-8",
) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name.replace(/[\\/:*?"<>|]/g, "-");
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export function quoteText(q: Reply["quote"]) {
  return typeof q === "string" ? q : q?.text || q?.body || "";
}
export function markdown(item: Item, items: Item[], replies: Reply[]) {
  const comments = replies
    .filter((r) => r.item_id === item.id && active(r))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const understanding = comments.find((x) => x.id === item.und);
  const attachments = (atts: Item["atts"]) =>
    (atts || [])
      .map(
        (a) =>
          `- ${a.name} (${a.size} bytes) · ${a.local ? "本地附件路径：" + a.path : "原云端引用：" + a.path}`,
      )
      .join("\n");
  return `# ${titleOf(item)}\n\n- ID：${item.id}\n- 类型：${kindLabel[item.type]}\n- 作者：${item.owner_name}\n- 创建：${item.created_at}\n- 更新：${item.updated_at}\n- 主题：${item.topic_ids.map((id) => items.find((x) => x.id === id)?.title || id).join("、")}\n${item.source ? "- 来源：" + item.source + "\n" : ""}\n## 原始记录\n\n${item.body}\n\n${item.atts?.length ? "## 附件\n\n" + attachments(item.atts) + "\n\n" : ""}${understanding ? "## 当前理解\n\n" + understanding.body + "\n\n" : ""}## 补充与进展\n\n${comments.map((r) => `### ${r.is_progress ? "进展" : "补充"} · ${r.owner_name} · ${r.created_at}\n\n${quoteText(r.quote) ? "> " + quoteText(r.quote).replaceAll("\n", "\n> ") + "\n\n" : ""}${r.body}\n\n${attachments(r.atts)}\n`).join("\n")}\n`;
}
export function reviewDue(x: Item) {
  return (
    !x.no_review &&
    !x.archived &&
    (!x.snooze_until || +new Date(x.snooze_until) <= Date.now()) &&
    (!x.review_due || +new Date(x.review_due) <= Date.now())
  );
}

export function roleLabel(role: string) {
  return (
    (
      {
        owner: "所有者",
        admin: "管理员",
        editor: "编辑成员",
        viewer: "只读成员",
      } as Record<string, string>
    )[role] || role
  );
}
