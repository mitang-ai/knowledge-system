import { createContext, useContext } from "react";
import type { Item, Preferences, Reply, View, Workspace } from "./types";
export type Dialog =
  | { type: "topic"; item?: Item }
  | { type: "merge"; item: Item }
  | {
      type: "space" | "join" | "invite" | "account" | "templates" | "shortcuts";
    }
  | {
      type: "confirm";
      title: string;
      message: string;
      action: () => Promise<void>;
    }
  | null;
export interface ContextValue {
  ws: Workspace;
  prefs: Preferences;
  space: string;
  scoped: Item[];
  topics: Item[];
  save: (item: Item) => Promise<Item>;
  saveReply: (reply: Reply) => Promise<Reply>;
  refresh: () => Promise<void>;
  notify: (text: string) => void;
  open: (id: string) => void;
  go: (view: View) => void;
  dialog: (value: Dialog) => void;
  topic: (id: string) => void;
  settings: (prefs: Preferences) => void;
  canWrite: boolean;
}
export const Context = createContext<ContextValue>(null!);
export const useWorkspace = () => useContext(Context);
export const labels: Record<View, string> = {
  home: "我的书桌",
  inbox: "收件箱",
  library: "全部知识",
  topics: "主题空间",
  review: "回顾",
  experiences: "经验手册",
  starred: "星标收藏",
  shared: "团队知识",
  settings: "偏好设置",
  manage: "管理工作台",
  reading: "文件与链接",
};
