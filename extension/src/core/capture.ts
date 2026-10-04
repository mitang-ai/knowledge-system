import type { CaptureEnvelope, CaptureSource, WritePayload } from "../types";

const tracking = /^(utm_.+|fbclid|gclid|dclid|msclkid|_hsenc|_hsmi)$/i;
const secrets =
  /^(access_token|refresh_token|token|api_?key|authorization|password|secret|session_?id|auth_?code|code|state)$/i;
export function safeURL(raw: string): string {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("只支持没有凭据的 HTTP/HTTPS 页面链接。");
  // Preserve document anchors and hash-router paths, but never OAuth/key fragments.
  let fragment = url.hash.slice(1);
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    /* Invalid encoding stays literal. */
  }
  if (
    fragment
      .split(/[?&]/)
      .some((part) => secrets.test(part.split("=", 1)[0]) && part.includes("="))
  )
    url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (tracking.test(key) || secrets.test(key)) url.searchParams.delete(key);
  return url.href;
}
export function serviceOrigin(raw: string): string {
  const u = new URL(raw.trim());
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (
    (u.protocol !== "https:" && !(u.protocol === "http:" && local)) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.pathname !== "/" && u.pathname !== "")
  )
    throw new Error(
      "系统地址需要 HTTPS；仅本机服务可使用 HTTP。不要填写路径或凭据。",
    );
  return u.origin;
}
export function redact(text: string, values: string[]): string {
  return values
    .filter((v) => v.length >= 4)
    .reduce((result, v) => result.split(v).join("[已隐藏凭据]"), text);
}
const checkedString = (value: unknown, name: string, max: number) => {
  if (typeof value !== "string" || value.length > max)
    throw new Error(name + "格式无效或过长。");
  return value;
};
function onlyFields(value: object, allowed: string[]) {
  if (Object.keys(value).some((k) => !allowed.includes(k)))
    throw new Error("捕获包包含不支持的字段；不接受密钥、令牌或可执行动作。");
}
export function validateCapture(value: unknown): CaptureEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("捕获包需要 JSON 对象。");
  onlyFields(value, [
    "schema",
    "id",
    "kind",
    "title",
    "text",
    "thought",
    "capturedAt",
    "source",
    "analysis",
  ]);
  const v = value as CaptureEnvelope;
  if (
    v.schema !== "sediment.capture.v1" ||
    !["thought", "article", "selection", "bookmark", "thread"].includes(v.kind)
  )
    throw new Error("不支持这个捕获包版本或类型。");
  checkedString(v.id, "记录 ID", 100);
  if (!v.id || !/^[a-zA-Z0-9_-]+$/.test(v.id))
    throw new Error("记录 ID 无效。");
  checkedString(v.title, "标题", 240);
  checkedString(v.text, "正文", 95000);
  checkedString(v.thought, "想法", 16000);
  if (!Number.isFinite(Date.parse(checkedString(v.capturedAt, "时间", 60))))
    throw new Error("捕获时间无效。");
  if (v.source) {
    onlyFields(v.source, [
      "url",
      "title",
      "author",
      "site",
      "coverage",
      "warnings",
    ]);
    safeURL(checkedString(v.source.url, "来源地址", 4096));
    checkedString(v.source.title, "来源标题", 240);
    if (v.source.author !== undefined)
      checkedString(v.source.author, "作者", 160);
    if (v.source.site !== undefined) checkedString(v.source.site, "站点", 160);
    if (
      ![
        "extracted-article",
        "selection-only",
        "loaded-content",
        "link-only",
      ].includes(v.source.coverage) ||
      !Array.isArray(v.source.warnings) ||
      v.source.warnings.length > 12
    )
      throw new Error("读取范围格式无效。");
    v.source.warnings.forEach((w) => checkedString(w, "读取说明", 300));
  }
  if (v.analysis) {
    onlyFields(v.analysis, [
      "text",
      "requestedModel",
      "model",
      "complete",
      "truncated",
      "task",
      "generatedAt",
    ]);
    checkedString(v.analysis.text, "AI 整理", 32000);
    checkedString(v.analysis.requestedModel, "请求模型", 200);
    checkedString(v.analysis.model, "返回模型", 200);
    if (
      typeof v.analysis.complete !== "boolean" ||
      typeof v.analysis.truncated !== "boolean" ||
      !["summary", "insight", "questions", "polish"].includes(
        v.analysis.task,
      ) ||
      !Number.isFinite(
        Date.parse(checkedString(v.analysis.generatedAt, "AI 时间", 60)),
      )
    )
      throw new Error("AI 归属或完成状态无效。");
  }
  const result = structuredClone(v);
  if (result.source) result.source.url = safeURL(result.source.url);
  return result;
}
export function scrubCapture(
  c: CaptureEnvelope,
  values: string[],
): CaptureEnvelope {
  const walk = (value: unknown): unknown =>
    typeof value === "string"
      ? redact(value, values)
      : Array.isArray(value)
        ? value.map(walk)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([k, v]) => [k, walk(v)]),
            )
          : value;
  return validateCapture(walk(c));
}
export function freshCapture(
  kind: CaptureEnvelope["kind"] = "thought",
  text = "",
  source?: CaptureSource,
): CaptureEnvelope {
  return {
    schema: "sediment.capture.v1",
    id: crypto.randomUUID(),
    kind,
    title: source?.title || "",
    text,
    thought: "",
    capturedAt: new Date().toISOString(),
    ...(source ? { source } : {}),
  };
}
export const coverageNames: Record<CaptureSource["coverage"], string> = {
  "extracted-article": "提取的文章正文",
  "selection-only": "仅选中的文字",
  "loaded-content": "仅当前已加载内容",
  "link-only": "仅标题和链接，未读取正文",
};
export function composeWrite(
  capture: CaptureEnvelope,
  space = "personal",
  credentials: string[] = [],
): WritePayload {
  const c = validateCapture(capture),
    pieces: string[] = [];
  if (c.thought.trim()) pieces.push("## 我的想法\n\n" + c.thought.trim());
  if (c.text.trim())
    pieces.push(
      (c.kind === "thought"
        ? ""
        : "## " + (c.kind === "selection" ? "原文摘录" : "原始材料") + "\n\n") +
        c.text.trim(),
    );
  if (c.source)
    pieces.push(
      "## 来源\n\n" +
        safeURL(c.source.url) +
        "\n\n" +
        coverageNames[c.source.coverage] +
        " · 捕获于 " +
        c.capturedAt +
        (c.source.author ? "\n作者：" + c.source.author : "") +
        (c.source.warnings.length
          ? "\n\n" + c.source.warnings.map((w) => "- " + w).join("\n")
          : ""),
    );
  if (c.analysis)
    pieces.push(
      "## AI 整理（需自行核对）\n\n" +
        c.analysis.text +
        "\n\n请求模型：" +
        c.analysis.requestedModel +
        "；返回模型：" +
        (c.analysis.model || "服务未声明") +
        (!c.analysis.complete || c.analysis.truncated
          ? "\n注意：回答未完整结束或受到输出长度限制。"
          : ""),
    );
  const content = redact(pieces.join("\n\n---\n\n"), credentials);
  if (!content.trim()) throw new Error("先写下一点想法，或者读取网页内容。");
  if (content.length > 100000)
    throw new Error(
      "这份材料超过系统单次 10 万字符限制。草稿已保留，请拆分后沉淀。",
    );
  return {
    action: "create_note",
    space_id: space,
    title: redact(c.title, credentials),
    content,
    source_refs: [],
    model_attribution: c.analysis
      ? {
          requested_model: redact(c.analysis.requestedModel, credentials),
          response_model: redact(c.analysis.model, credentials),
          generated_at: c.analysis.generatedAt,
        }
      : {},
  };
}
