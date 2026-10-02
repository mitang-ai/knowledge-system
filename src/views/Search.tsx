import { ArrowUpRight, FileText, Search } from "lucide-react";
import { useState } from "react";
import { active, dateOf, kindLabel, titleOf } from "../lib";

import { Empty, Overlay } from "../ui";
import { useWorkspace } from "../workspace";
export function SearchDialog({ close }: { close: () => void }) {
  const { ws, open } = useWorkspace();
  const [q, setQ] = useState(""),
    [kind, setKind] = useState("all"),
    [progress, setProgress] = useState(false),
    [scope, setScope] = useState("all"),
    [time, setTime] = useState("all");
  const query = q.trim().toLowerCase();
  const cutoff =
    time === "week"
      ? Date.now() - 7 * 86400000
      : time === "month"
        ? Date.now() - 30 * 86400000
        : 0;
  const matches = ws.items.filter(
    (n) =>
      active(n) &&
      n.type !== "topic" &&
      (kind === "all" || n.type === kind) &&
      (scope === "all" ||
        (scope === "personal" ? !n.space_id : !!n.space_id)) &&
      +new Date(n.created_at) >= cutoff &&
      (!progress ||
        ws.replies.some(
          (r) => r.item_id === n.id && r.is_progress && active(r),
        )),
  );
  const results = matches
    .flatMap((n) => {
      const comments = ws.replies.filter(
        (r) => r.item_id === n.id && active(r),
      );
      const hit = comments.find((r) => r.body.toLowerCase().includes(query));
      return !query ||
        (n.title + " " + n.body).toLowerCase().includes(query) ||
        hit
        ? [
            {
              item: n,
              comment:
                query &&
                !n.body.toLowerCase().includes(query) &&
                !n.title.toLowerCase().includes(query)
                  ? hit
                  : undefined,
            },
          ]
        : [];
    })
    .sort((a, b) => b.item.updated_at.localeCompare(a.item.updated_at))
    .slice(0, 40);
  const highlight = (text: string) => {
    if (!query) return text.slice(0, 110);
    const at = text.toLowerCase().indexOf(query);
    const start = Math.max(0, at - 35),
      snippet = text.slice(start, start + 130);
    const split = snippet.toLowerCase().indexOf(query);
    return split < 0 ? (
      snippet
    ) : (
      <>
        {start > 0 ? "…" : ""}
        {snippet.slice(0, split)}
        <mark>{snippet.slice(split, split + query.length)}</mark>
        {snippet.slice(split + query.length)}
      </>
    );
  };
  return (
    <Overlay title="搜索你的知识" onClose={close} wide>
      <div className="search-input">
        <Search size={23} />
        <input
          autoFocus
          placeholder="搜索记录、经验与补充…"
          aria-label="全局搜索关键词"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results[0]) {
              open(results[0].item.id);
              close();
            }
          }}
        />
        <kbd>ESC</kbd>
      </div>
      <div className="search-filters">
        <select
          aria-label="搜索内容类型"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="all">所有类型</option>
          <option value="note">记录</option>
          <option value="experience">经验</option>
          <option value="resource">资料</option>
        </select>
        <select
          aria-label="搜索空间范围"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          <option value="all">可访问的全部空间</option>
          <option value="personal">个人空间</option>
          <option value="team">团队空间</option>
        </select>
        <select
          aria-label="搜索时间范围"
          value={time}
          onChange={(e) => setTime(e.target.value)}
        >
          <option value="all">不限时间</option>
          <option value="week">最近 7 天</option>
          <option value="month">最近 30 天</option>
        </select>
        <label>
          <input
            type="checkbox"
            checked={progress}
            onChange={(e) => setProgress(e.target.checked)}
          />
          包含进展
        </label>
      </div>
      <div className="search-result-label">
        {query ? `${results.length} 条匹配结果` : "最近更新的知识"}
        <span>↵ 打开第一条</span>
      </div>
      <div className="search-results">
        {results.map(({ item, comment }) => (
          <button
            key={item.id}
            onClick={() => {
              open(item.id);
              close();
            }}
          >
            <FileText size={18} />
            <div>
              <h3>{highlight(titleOf(item))}</h3>
              <p>
                {comment && <span className="tag">命中补充</span>}
                {highlight(comment?.body || item.body)}
              </p>
              <small>
                {item.space_id
                  ? ws.spaces.find((s) => s.id === item.space_id)?.name
                  : "个人空间"}{" "}
                · {kindLabel[item.type]} · {dateOf(item.created_at, true)}
              </small>
            </div>
            <ArrowUpRight size={15} />
          </button>
        ))}
      </div>
      {!results.length && (
        <Empty
          title="没有找到相符的知识"
          description="试试更短的关键词，或调整范围和类型。"
        />
      )}
    </Overlay>
  );
}
