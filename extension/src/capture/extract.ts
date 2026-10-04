import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { freshCapture, safeURL } from "../core/capture";
import type { CaptureEnvelope, CaptureSource } from "../types";

export interface SiteAdapter {
  id: string;
  match(url: URL): boolean;
  extract(
    document: Document,
    url: URL,
  ): {
    html: string;
    coverage: CaptureSource["coverage"];
    warnings: string[];
  } | null;
}
function clean(document: Document) {
  document
    .querySelectorAll(
      "script,style,noscript,iframe,form,input,textarea,select,button,nav,footer,[hidden],[aria-hidden=true],[contenteditable=true]",
    )
    .forEach((n) => n.remove());
  for (const node of document.querySelectorAll("*")) {
    for (const attr of [...node.attributes])
      if (attr.name.startsWith("on")) node.removeAttribute(attr.name);
  }
}
export const siteAdapters: SiteAdapter[] = [
  {
    id: "x-loaded-posts",
    match: (u) =>
      ["x.com", "twitter.com", "www.x.com", "www.twitter.com"].includes(
        u.hostname,
      ),
    extract: (doc, url) => {
      let articles = [...doc.querySelectorAll("article[data-testid=tweet]")];
      const status = url.pathname.match(/\/status\/\d+/)?.[0];
      if (status) {
        const exact = articles.filter((a) =>
          [...a.querySelectorAll("a[href]")].some((n) =>
            n.getAttribute("href")?.includes(status),
          ),
        );
        if (exact.length) articles = exact;
      }
      const html = articles
        .slice(0, 30)
        .map((a) => {
          const text = a.querySelector("[data-testid=tweetText]");
          if (!text) return "";
          return (
            (a.querySelector("[data-testid=User-Name]")?.outerHTML || "") +
            text.outerHTML
          );
        })
        .filter(Boolean)
        .join("<hr>");
      return html
        ? {
            html,
            coverage: "loaded-content",
            warnings: [
              "只读取页面中已加载的帖子文字，不包含未展开的长文、未加载的回复、图片原件或视频。",
            ],
          }
        : null;
    },
  },
  {
    id: "reddit-loaded-discussion",
    match: (u) => /(^|\.)reddit\.com$/.test(u.hostname),
    extract: (doc) => {
      const post = doc.querySelector(
        "shreddit-post,[data-testid=post-content],main article",
      );
      if (!post) return null;
      const comments = [
        ...doc.querySelectorAll("shreddit-comment,[data-testid=comment]"),
      ].slice(0, 40);
      return {
        html: post.outerHTML + comments.map((n) => n.outerHTML).join("<hr>"),
        coverage: "loaded-content",
        warnings: [
          "只包含 DOM 中已加载的帖子与评论；不展开更多回复，不读取封闭 Shadow DOM。",
        ],
      };
    },
  },
];
function markdown(html: string, base: string) {
  const converter = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  converter.addRule("safe-link", {
    filter: "a",
    replacement: (text, node) => {
      try {
        const url = safeURL(
          new URL((node as Element).getAttribute("href") || "", base).href,
        );
        return text.trim() ? `[${text.replace(/[\[\]]/g, "")}](<${url}>)` : "";
      } catch {
        return text;
      }
    },
  });
  converter.addRule("image-source-only", {
    filter: "img",
    replacement: (_text, node) => {
      const n = node as Element;
      try {
        const url = safeURL(new URL(n.getAttribute("src") || "", base).href);
        return `\n[图片来源：${(n.getAttribute("alt") || "未命名图片").replace(/[\[\]]/g, "")}](<${url}>)\n`;
      } catch {
        return "";
      }
    },
  });
  return converter.turndown(html).trim();
}
/** Parse an inert clone only; never mutate the live page or fetch extra content. */
export function extractDocument(
  document: Document,
  selectedText = "",
): CaptureEnvelope {
  const url = new URL(safeURL(document.URL));
  const title = (document.title || url.hostname).trim().slice(0, 240);
  const source: CaptureSource = {
    url: url.href,
    title,
    site: url.hostname,
    coverage: "link-only",
    warnings: [],
  };
  if (selectedText.trim()) {
    source.coverage = "selection-only";
    if (selectedText.trim().length > 95000)
      source.warnings.push(
        "选区超过 95,000 字符，仅保留前 95,000 字符；这不是完整归档。",
      );
    return freshCapture(
      "selection",
      selectedText.trim().slice(0, 95000),
      source,
    );
  }
  const clone = document.cloneNode(true) as Document;
  clean(clone);
  const adapter = siteAdapters.find((a) => a.match(url));
  let content = adapter?.extract(clone, url),
    text = "";
  if (!content) {
    try {
      const article = new Readability(clone, { charThreshold: 120 }).parse();
      if (
        article &&
        article.textContent &&
        article.textContent.trim().length >= 80
      ) {
        content = {
          html: article.content || "",
          coverage: "extracted-article",
          warnings: [],
        };
        if (article.byline) source.author = article.byline.trim().slice(0, 160);
      }
    } catch {
      /* An unreadable document remains a clearly labelled bookmark. */
    }
  }
  if (content) {
    text = markdown(content.html, url.href);
    source.coverage = content.coverage;
    source.warnings = content.warnings;
    if (/<img\b/i.test(content.html))
      source.warnings.push(
        "图片仅保留来源链接，尚未保存为系统附件；原站移除图片后链接可能失效。",
      );
  }
  if (!text || (source.coverage === "extracted-article" && text.length < 20)) {
    source.coverage = "link-only";
    source.warnings = [
      "没有取得可读正文。可选中文字重新捕获，或直接粘贴正文；不会假称已保存全文。",
    ];
  }
  if (text.length > 95000) {
    text = text.slice(0, 95000);
    source.warnings.push(
      "材料超过 95,000 字符，仅保留前 95,000 字符；这不是完整归档。",
    );
  }
  if (document.querySelector("iframe"))
    source.warnings.push("不读取跨域 iframe 内的正文。");
  return freshCapture(
    source.coverage === "link-only"
      ? "bookmark"
      : source.coverage === "loaded-content"
        ? "thread"
        : "article",
    text,
    source,
  );
}
