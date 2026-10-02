export type Kind = "note" | "topic" | "experience" | "resource";
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
  local?: boolean;
}
export interface Item {
  id: string;
  owner_id: string;
  owner_name: string;
  type: Kind;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
  last_active_at?: string;
  last_opened_at?: string | null;
  topic_ids: string[];
  source?: string | null;
  und?: string | null;
  und_hist?: { r: string; t: number }[] | null;
  atts: Attachment[];
  deleted_at?: string | null;
  exp_st?: string | null;
  exp_src?: string | null;
  unclear?: boolean;
  no_review?: boolean;
  snooze_until?: string | null;
  starred?: boolean;
  reviewed_at?: string | null;
  review_due?: string | null;
  review_interval?: number;
  review_count?: number;
  color?: string;
  archived?: boolean;
  body_prev?: string | null;
  edited_body_at?: string | null;
  space_id?: string | null;
  [key: string]: unknown;
}
export interface Reply {
  id: string;
  item_id: string;
  owner_id: string;
  owner_name: string;
  body: string;
  created_at: string;
  edited_at?: string | null;
  updated_at?: string;
  is_progress: boolean;
  quote?: string | { text?: string; body?: string } | null;
  atts: Attachment[];
  deleted_at?: string | null;
  ai?: Record<string, unknown>;
}
export interface Profile {
  owner_id: string;
  display_name: string;
}
export interface Backup {
  id: string;
  at: string;
}
export interface Preferences {
  font: string;
  size: number;
  uiSize: number;
  headingSize: number;
  lineHeight: number;
  width: number;
  theme: "light" | "dark" | "system";
  density: "comfortable" | "compact";
  motion: boolean;
  accent: "green" | "blue" | "graphite";
}
export interface Space {
  id: string;
  name: string;
  description: string;
  owner: string;
  role: "owner" | "admin" | "editor" | "viewer";
}
export interface Member {
  space: string;
  account: string;
  role: Space["role"];
}
export interface Workspace {
  items: Item[];
  replies: Reply[];
  profiles: Profile[];
  me: Profile;
  preferences: Partial<Preferences>;
  backups: Backup[];
  mode: "local";
  spaces: Space[];
  members: Member[];
  account_enabled: boolean;
  platform_admin: boolean;
}
export interface Version {
  id: string;
  at: string;
  item: Item;
}
export type View =
  | "home"
  | "inbox"
  | "library"
  | "topics"
  | "review"
  | "experiences"
  | "starred"
  | "shared"
  | "settings"
  | "manage"
  | "reading";
