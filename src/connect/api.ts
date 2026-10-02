export class OpenAPIError extends Error {
  constructor(
    message: string,
    public code: string,
    public requestId?: string,
  ) {
    super(message);
  }
}
export async function knowledgeAPI<T>(
  path: string,
  data?: unknown,
): Promise<T> {
  const response = await fetch("/api/v1/" + path, {
    method: data === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-Sediment-Interactive": "1",
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new OpenAPIError(
      result.error?.message || "操作未完成",
      result.error?.code || "request_failed",
      result.request_id,
    );
  return result as T;
}
export const fieldNames: Record<string, string> = {
  original: "原始记录",
  current_understanding: "当前理解",
  replies: "补充与进展",
  experience: "经验内容",
  validation: "验证依据",
  provenance: "来源关系",
  history: "历史修订",
  attachment_metadata: "附件与原件",
};
export const scopeNames: Record<string, string> = {
  "knowledge:read": "阅读与搜索",
  "proposals:create": "提交待采纳建议",
  "knowledge:export": "生成外部沉淀计划",
  "exports:run": "执行已批准计划",
  "changes:read": "读取增量变化",
  "history:read": "读取历史修订",
  "attachments:read": "读取附件原件",
  "knowledge:write": "直接写入（每日限额）",
};
export const partNames: Record<string, string> = {
  ...fieldNames,
  original_segment: "原始记录",
  reply: "补充与进展",
  provenance_relation: "来源关系",
  attachment: "附件与原件",
};
export const statusNames: Record<string, string> = {
  awaiting_approval: "待你确认",
  approved: "等待本地连接器",
  running: "正在执行",
  completed: "已完成",
  partial: "需要核对",
  failed: "执行失败",
  unknown_result: "结果待核对",
  cancel_requested: "已请求取消",
  cancelled: "已取消",
  rejected: "未采纳",
};
export interface Policy {
  space_ids: string[];
  topic_ids: string[];
  item_ids: string[];
  excluded_item_ids: string[];
  fields: string[];
  scopes: string[];
  dynamic_membership: boolean;
  captured_item_ids?: string[];
  allowed_write_actions?: string[];
  max_new_items_per_day?: number;
}
export interface Grant {
  id: string;
  name: string;
  enabled: boolean;
  expires: string;
  policy: Policy;
  parent_client?: string;
  token?: string;
}
export interface Fragment {
  item_id: string;
  revision: number;
  part_id: string;
  part_type: string;
  title: string;
  text: string;
  citation_id: string;
  completeness: string;
  author: { id: string; display_name: string };
}
export interface KnowledgePackage {
  snapshot_id: string;
  space_id: string;
  source_refs: { item_id: string; revision: number; part_id?: string }[];
  fields: string[];
  fragments: Fragment[];
  markdown: string;
  coverage: { complete: boolean; truncated: boolean; warnings: string[] };
}
export interface Operation {
  id: string;
  status: string;
  created: string;
  data: {
    action?: string;
    space_id: string;
    content: string;
    destination?: string;
    target_id?: string;
    title?: string;
    format?: string;
    allow_update?: boolean;
    model_attribution?: Record<string, string>;
    package?: KnowledgePackage;
    source_refs?: { item_id: string; revision: number; part_id?: string }[];
    target_item_id?: string;
  };
  result?: {
    verification?: string;
    read_back_verified?: boolean;
    destination_url?: string;
    warnings?: string[];
    item_id?: string;
  };
}
export interface Destination {
  id: string;
  name: string;
  kind: "obsidian" | "feishu" | "ima";
  target_id: string;
  mode?: string;
  vault?: string;
  folder?: string;
  app_id?: string;
  app_secret?: string;
  user_token?: string;
  folder_token?: string;
  wiki_space?: string;
  parent_node?: string;
  client_id?: string;
  api_key?: string;
  folder_id?: string;
  knowledge_base_id?: string;
}
export function destinationProfiles(owner: string): Destination[] {
  try {
    const profiles = JSON.parse(
      localStorage.getItem("sediment-destinations:" + owner) || "[]",
    );
    return Array.isArray(profiles)
      ? profiles.filter(
          (p): p is Destination =>
            p &&
            typeof p.id === "string" &&
            typeof p.name === "string" &&
            typeof p.target_id === "string" &&
            ["obsidian", "feishu", "ima"].includes(p.kind),
        )
      : [];
  } catch {
    return [];
  }
}
export function saveDestinations(owner: string, profiles: Destination[]) {
  localStorage.setItem(
    "sediment-destinations:" + owner,
    JSON.stringify(profiles),
  );
}
