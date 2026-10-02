import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  Copy,
  KeyRound,
  Link2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useWorkspace } from "../workspace";
import { useAI } from "../ai/context";
import { scrubSecrets } from "../ai/storage";
import { download, titleOf, dateOf, newId } from "../lib";
import { Overlay } from "../ui";
import { BrandMark } from "../Brand";
import {
  destinationProfiles,
  saveDestinations,
  fieldNames,
  scopeNames,
  statusNames,
  knowledgeAPI,
  type Destination,
  type Grant,
  type Operation,
  type Policy,
} from "./api";

const defaults: Policy = {
  space_ids: ["personal"],
  topic_ids: [],
  item_ids: [],
  excluded_item_ids: [],
  fields: [
    "original",
    "current_understanding",
    "experience",
    "validation",
    "provenance",
  ],
  scopes: ["knowledge:read"],
  dynamic_membership: false,
  allowed_write_actions: ["create_note", "append_reply"],
  max_new_items_per_day: 10,
};
const changeList = (list: string[], value: string) =>
  list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
const actionNames: Record<string, string> = {
  create_note: "新增记录",
  append_reply: "补充原文",
  suggest_understanding: "更新当前理解",
  suggest_experience: "沉淀为经验",
};
export function ScopeForm({
  policy,
  set,
  requestedScopes,
}: {
  policy: Policy;
  set: (p: Policy) => void;
  requestedScopes?: string[];
}) {
  const { ws } = useWorkspace();
  const visible = ws.items.filter(
    (i) => !i.deleted_at && policy.space_ids.includes(i.space_id || "personal"),
  );
  const update = (p: Partial<Policy>) => set({ ...policy, ...p });
  return (
    <div className="scope-form">
      <label className="connect-field">
        知识空间
        <select
          value={policy.space_ids[0]}
          onChange={(e) =>
            update({
              space_ids: [e.target.value],
              topic_ids: [],
              item_ids: [],
              excluded_item_ids: [],
            })
          }
        >
          <option value="personal">我的个人空间</option>
          {ws.spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <div className="connect-two">
        <label className="connect-field">
          主题范围
          <select
            value={policy.topic_ids[0] || ""}
            onChange={(e) =>
              update({
                topic_ids: e.target.value ? [e.target.value] : [],
                item_ids: [],
              })
            }
          >
            <option value="">所选空间内的全部主题</option>
            {visible
              .filter((i) => i.type === "topic")
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {titleOf(i)}
                </option>
              ))}
          </select>
        </label>
        <label className="connect-field">
          授权有效期
          <select
            value={String(
              (policy as Policy & { expires_days?: number }).expires_days || 30,
            )}
            onChange={(e) =>
              set({ ...policy, expires_days: Number(e.target.value) } as Policy)
            }
          >
            <option value="7">7 天</option>
            <option value="30">30 天</option>
            <option value="90">90 天</option>
          </select>
        </label>
      </div>
      <details>
        <summary>精确选择条目与排除项</summary>
        <div className="scope-item-list">
          {visible
            .filter(
              (i) =>
                !policy.topic_ids.length ||
                i.topic_ids.includes(policy.topic_ids[0]) ||
                i.id === policy.topic_ids[0],
            )
            .map((i) => (
              <div key={i.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={policy.item_ids.includes(i.id)}
                    onChange={() =>
                      update({ item_ids: changeList(policy.item_ids, i.id) })
                    }
                  />
                  {titleOf(i)}
                </label>
                <label className="scope-exclude">
                  <input
                    type="checkbox"
                    checked={policy.excluded_item_ids.includes(i.id)}
                    onChange={() =>
                      update({
                        excluded_item_ids: changeList(
                          policy.excluded_item_ids,
                          i.id,
                        ),
                      })
                    }
                  />
                  排除
                </label>
              </div>
            ))}
        </div>
        <p className="connect-muted">
          未勾选具体条目时，使用上述空间与主题范围；排除项始终优先。
        </p>
      </details>
      <label className="connect-check scope-dynamic">
        <input
          type="checkbox"
          checked={policy.dynamic_membership}
          onChange={(e) => update({ dynamic_membership: e.target.checked })}
        />
        <span>
          也允许访问以后加入这个范围的知识
          <small>默认只包含本次授权时已存在的条目。</small>
        </span>
      </label>
      <h3>可以读取哪些内容</h3>
      <div className="connect-checkbox-grid">
        {Object.entries(fieldNames)
          .filter(
            ([id]) =>
              !requestedScopes ||
              (id === "history"
                ? requestedScopes.includes("history:read")
                : id === "attachment_metadata"
                  ? requestedScopes.includes("attachments:read")
                  : true),
          )
          .map(([id, label]) => (
            <label key={id}>
              <input
                type="checkbox"
                checked={policy.fields.includes(id)}
                onChange={() => {
                  let scopes = policy.scopes;
                  const independent =
                    id === "history"
                      ? "history:read"
                      : id === "attachment_metadata"
                        ? "attachments:read"
                        : null;
                  if (independent)
                    scopes = policy.fields.includes(id)
                      ? scopes.filter((scope) => scope !== independent)
                      : [...new Set([...scopes, independent])];
                  update({ fields: changeList(policy.fields, id), scopes });
                }}
              />
              {label}
            </label>
          ))}
      </div>
      <h3>可以进行哪些操作</h3>
      <div className="connect-checkbox-grid">
        {Object.entries(scopeNames)
          .filter(([id]) => !requestedScopes || requestedScopes.includes(id))
          .map(([id, label]) => (
            <label key={id}>
              <input
                type="checkbox"
                checked={policy.scopes.includes(id)}
                disabled={id === "knowledge:read"}
                onChange={() => {
                  const field =
                    id === "history:read"
                      ? "history"
                      : id === "attachments:read"
                        ? "attachment_metadata"
                        : null;
                  const fields = field
                    ? policy.scopes.includes(id)
                      ? policy.fields.filter((value) => value !== field)
                      : [...new Set([...policy.fields, field])]
                    : policy.fields;
                  update({ scopes: changeList(policy.scopes, id), fields });
                }}
              />
              {label}
            </label>
          ))}
      </div>
      {policy.scopes.includes("knowledge:write") && (
        <div className="connect-direct">
          <p>
            直接写入不会经过待采纳确认。仅允许新增记录和补充原文；不会替换原文或自动更新当前理解。
          </p>
          <label className="connect-field">
            每日直接写入上限
            <input
              type="number"
              min="1"
              max="1000"
              value={policy.max_new_items_per_day}
              onChange={(e) =>
                update({ max_new_items_per_day: Number(e.target.value) })
              }
            />
          </label>
        </div>
      )}
    </div>
  );
}
export function TokenDialog({
  token,
  name,
  close,
}: {
  token: string;
  name: string;
  close: () => void;
}) {
  const { notify } = useWorkspace();
  return (
    <Overlay title="保存访问令牌" onClose={close}>
      <div className="connect-flow">
        <div className="connect-icon">
          <KeyRound size={22} />
        </div>
        <h3>{name}</h3>
        <p>
          令牌仅在此处显示一次。服务端只保留哈希；请放入自己的系统钥匙串或环境变量，不要发到聊天、代码或帖子中。
        </p>
        <textarea
          className="token-once"
          aria-label="一次性访问令牌"
          readOnly
          value={token}
          spellCheck={false}
        />
        <button
          className="quiet-button"
          onClick={() =>
            void navigator.clipboard
              .writeText(token)
              .then(() => notify("已复制，请妥善保存"))
              .catch(() => notify("请手动复制令牌"))
          }
        >
          <Copy size={14} />
          复制令牌
        </button>
        <div className="connect-code">
          <code>
            sediment profile-add default --url {location.origin}
            <br />
            sediment capabilities
            <br />
            sediment mcp
          </code>
        </div>
        <p className="connect-muted">
          profile-add 默认读取 SEDIMENT_TOKEN；使用「sediment keychain-set
          名称」可把令牌保存到系统钥匙串。浏览器不会记住这个令牌。
        </p>
        <button className="primary" onClick={close}>
          我已保存
        </button>
      </div>
    </Overlay>
  );
}
export function GrantDialog({
  close,
  created,
  service = false,
}: {
  close: () => void;
  created: (g: Grant) => void;
  service?: boolean;
}) {
  const { notify, ws } = useWorkspace(),
    [name, setName] = useState(service ? "团队知识助手" : "我的 Agent"),
    [policy, setPolicy] = useState<Policy>({
      ...defaults,
      ...(service
        ? {
            space_ids: [
              ws.spaces.find((s) => s.role === "owner" || s.role === "admin")
                ?.id || "personal",
            ],
          }
        : {}),
    }),
    [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const grant = await knowledgeAPI<Grant>(
        service ? "service-accounts" : "grants",
        service
          ? {
              name,
              space_id: policy.space_ids[0],
              role: policy.scopes.some(
                (s) => s === "proposals:create" || s === "knowledge:write",
              )
                ? "editor"
                : "viewer",
              policy: { ...policy, name },
            }
          : { ...policy, name },
      );
      created(grant);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Overlay
      title={service ? "创建团队服务账号" : "授权一个 Agent"}
      onClose={close}
      wide
    >
      <div className="connect-flow">
        <p className="connect-intro">
          {service
            ? "服务账号只属于一个团队，通过受限令牌工作；不拥有个人知识和平台管理权限。"
            : "第三方 Agent 将获得所授权的明文。撤销可阻断后续访问，无法收回它已经保存的副本。待采纳与外发审批由你掌握。"}
        </p>
        <label className="connect-field">
          {service ? "服务账号" : "Agent"}名称
          <input
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <ScopeForm policy={policy} set={setPolicy} />
        <div className="connect-footer">
          <span>范围、层次、操作和有效期会一同保存。</span>
          <button
            className="primary"
            disabled={
              busy ||
              !name.trim() ||
              !policy.fields.length ||
              (service && policy.space_ids[0] === "personal")
            }
            onClick={() => void submit()}
          >
            <KeyRound size={15} />
            {busy ? "创建中…" : "创建授权"}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
export function Operations({ compact = false }: { compact?: boolean }) {
  const ai = useAI();
  const { notify, refresh, open } = useWorkspace(),
    [data, setData] = useState<{
      proposals: Operation[];
      exports: Operation[];
    }>({ proposals: [], exports: [] }),
    [review, setReview] = useState<Operation | null>(null),
    [content, setContent] = useState(""),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const load = () =>
    knowledgeAPI<typeof data>("operations")
      .then((d) => {
        setData(d);
        setLoaded(true);
        const wanted = new URLSearchParams(location.search).get("review");
        if (wanted) {
          const operation = [...d.proposals, ...d.exports].find(
            (o) => o.id === wanted,
          );
          if (operation) {
            setReview(operation);
            setContent(operation.data.content || "");
            history.replaceState(null, "", location.pathname);
          }
        }
      })
      .catch((e) => notify(e.message));
  useEffect(() => {
    void load();
  }, []);
  const act = async (action: string) => {
    if (!review) return;
    setBusy(true);
    try {
      const endpoint = review.data.action ? "proposals" : "export-plans";
      await knowledgeAPI(endpoint + "/" + review.id + "/" + action, {
        content: scrubSecrets(content, ai.config),
      });
      await refresh();
      setReview(null);
      await load();
      notify(
        action === "adopt"
          ? "已采纳并保留来源"
          : action === "approve"
            ? "已确认，等待本地连接器"
            : "已处理",
      );
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const rows = [...data.proposals, ...data.exports]
    .sort((a, b) => b.created.localeCompare(a.created))
    .filter((o) => !compact || o.status === "awaiting_approval");
  if (compact && !rows.length) return null;
  return (
    <section
      className={"operations-panel " + (compact ? "operations-compact" : "")}
    >
      <div className="connect-section-head">
        <div>
          <h3>{compact ? "Agent 待采纳" : "建议与沉淀记录"}</h3>
          <p>
            {compact
              ? "核对来源，再把新的理解写进自己的知识。"
              : "批准稿件、查看执行与回读结果。连接器未运行时，任务保持等待。"}
          </p>
        </div>
        <button className="quiet-button" onClick={() => void load()}>
          <RefreshCw size={14} />
          刷新
        </button>
      </div>
      {loaded && !rows.length ? (
        <div className="connect-empty small">
          <Check size={22} />
          <p>目前没有待处理记录</p>
        </div>
      ) : (
        <div className="connect-rows">
          {rows.map((o) => (
            <article className="connect-row" key={o.id}>
              <div className="connect-row-icon">
                {o.data.action ? (
                  <ShieldCheck size={17} />
                ) : (
                  <ArrowUpRight size={17} />
                )}
              </div>
              <div>
                <strong>
                  {o.data.action
                    ? actionNames[o.data.action]
                    : o.data.title || "知识沉淀"}
                </strong>
                <p>
                  {o.data.action
                    ? o.data.content?.slice(0, 90)
                    : `${o.data.destination} · ${o.data.target_id}`}
                </p>
                <small>
                  {dateOf(o.created)} · {statusNames[o.status] || o.status}
                  {o.result?.read_back_verified
                    ? " · 本地连接器已回读"
                    : o.status === "completed"
                      ? " · 尚无回读确认"
                      : ""}
                </small>
              </div>
              <button
                className="quiet-button"
                onClick={() => {
                  setReview(o);
                  setContent(o.data.content || "");
                }}
              >
                {o.status === "awaiting_approval" ? "审核" : "查看"}
              </button>
            </article>
          ))}
        </div>
      )}
      {review && (
        <Overlay
          title={review.data.action ? "审核待采纳建议" : "审核沉淀计划"}
          onClose={() => setReview(null)}
          wide
        >
          <div className="connect-flow">
            <div className="connect-preview-head">
              <strong>
                {review.data.action
                  ? actionNames[review.data.action]
                  : review.data.title}
              </strong>
              <span>{statusNames[review.status]}</span>
            </div>
            <p>
              {review.data.target_item_id ? (
                <button
                  className="text-button"
                  onClick={() => {
                    setReview(null);
                    open(review.data.target_item_id!);
                  }}
                >
                  查看目标原文
                  <ArrowUpRight size={13} />
                </button>
              ) : review.data.target_id ? (
                `目的地 ${review.data.destination} · ${review.data.target_id}`
              ) : (
                "新增记录"
              )}
            </p>
            {!review.data.action && (
              <div className="connect-approval-details">
                <p>
                  版式：
                  {review.data.format === "edited_document"
                    ? "整理成文"
                    : "完整记录"}
                </p>
                <p>
                  {review.data.allow_update
                    ? "允许更新先前的托管笔记；外部修改时停止，飞书与 ima 始终创建新版本。"
                    : "仅创建新版本，保留目的地已有内容。"}
                </p>
                {review.data.model_attribution?.requested_model && (
                  <p>
                    整理模型：{review.data.model_attribution.requested_model}
                    {review.data.model_attribution.response_model
                      ? " · 响应版本 " +
                        review.data.model_attribution.response_model
                      : ""}
                    {review.data.model_attribution.output_status &&
                    review.data.model_attribution.output_status !== "complete"
                      ? " · 稿件不完整，请核对"
                      : ""}
                  </p>
                )}
              </div>
            )}
            <div className="connect-source-refs">
              {(
                review.data.source_refs ||
                review.data.package?.source_refs ||
                []
              ).map((r) => (
                <button
                  key={r.item_id + ":" + r.part_id}
                  onClick={() => {
                    setReview(null);
                    open(r.item_id);
                  }}
                >
                  {r.item_id.slice(0, 10)} · 修订 {r.revision}
                  {r.part_id ? " / " + r.part_id : ""}
                </button>
              ))}
            </div>
            <label className="connect-field">
              {review.status === "awaiting_approval"
                ? "核对并编辑内容"
                : "确认稿件"}
              <textarea
                rows={14}
                value={content}
                readOnly={review.status !== "awaiting_approval"}
                onChange={(e) => setContent(e.target.value)}
                aria-label="审核内容"
              />
            </label>
            {review.result && (
              <div className="connect-receipt">
                <strong>
                  {review.result.read_back_verified
                    ? "本地连接器报告回读一致"
                    : "执行回执"}
                </strong>
                <p>验证级别：连接器报告；服务端没有独立访问外部平台。</p>
                {review.result.destination_url && (
                  <a
                    className="text-button"
                    href={review.result.destination_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    打开目的地
                    <ArrowUpRight size={13} />
                  </a>
                )}
                {review.result.warnings?.map((w) => (
                  <p key={w}>{w}</p>
                ))}
              </div>
            )}
            {review.status === "awaiting_approval" ? (
              <div className="connect-footer">
                <button
                  className="quiet-button"
                  disabled={busy}
                  onClick={() =>
                    void act(review.data.action ? "reject" : "cancel")
                  }
                >
                  暂不{review.data.action ? "采纳" : "沉淀"}
                </button>
                <button
                  className="primary"
                  disabled={busy || !content.trim()}
                  onClick={() =>
                    void act(review.data.action ? "adopt" : "approve")
                  }
                >
                  <Check size={15} />
                  {review.data.action ? "采纳到知识空间" : "确认稿件与目标"}
                </button>
              </div>
            ) : (
              <>
                {review.status === "approved" && (
                  <div className="connect-code">
                    <code>
                      sediment connector run --plan {review.id} --destination
                      本地配置名
                    </code>
                  </div>
                )}
                {["approved", "running"].includes(review.status) && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => void act("cancel")}
                  >
                    取消任务
                  </button>
                )}
              </>
            )}
          </div>
        </Overlay>
      )}
    </section>
  );
}
export function Connections() {
  const { ws, notify } = useWorkspace(),
    [tab, setTab] = useState(
      new URLSearchParams(location.search).has("review")
        ? "operations"
        : "agents",
    ),
    [grants, setGrants] = useState<Grant[]>([]),
    [dialog, setDialog] = useState(""),
    [token, setToken] = useState<Grant | null>(null),
    [profiles, setProfiles] = useState(() =>
      destinationProfiles(ws.me.owner_id),
    ),
    [cap, setCap] = useState<{ mcp_url: string; api_url: string } | null>(null);
  const load = () =>
    knowledgeAPI<{ grants: Grant[] }>("grants")
      .then((d) => setGrants(d.grants))
      .catch((e) => notify(e.message));
  useEffect(() => {
    void load();
    void knowledgeAPI<typeof cap>("capabilities")
      .then(setCap)
      .catch((e) => notify(e.message));
  }, []);
  const created = (g: Grant) => {
    setDialog("");
    setToken(g);
    void load();
  };
  const revoke = async (g: Grant) => {
    try {
      await knowledgeAPI("grants/" + g.id + "/revoke", {});
      await load();
      notify("授权已撤销");
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return (
    <div className="connections">
      <div className="connections-intro">
        <div className="connect-icon">
          <Link2 size={24} />
        </div>
        <div>
          <h2>连接你的知识工具</h2>
          <p>
            让自己的 Agent
            读取指定知识，把整理后的内容带到常用的工具。范围由你决定，每一次沉淀都有来源。
          </p>
        </div>
      </div>
      <div className="connect-nav">
        {[
          ["agents", "Agent 授权"],
          ["destinations", "沉淀目的地"],
          ["operations", "建议与执行"],
          ["rules", "增量规则"],
          ["audit", "访问记录"],
          ["team", "团队策略"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "selected" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "agents" && (
        <>
          <div className="connect-section-head">
            <div>
              <h3>谁可以访问你的知识</h3>
              <p>默认只读选定内容；提交建议、历史、附件与直接写入分别授权。</p>
            </div>
            <button className="primary" onClick={() => setDialog("grant")}>
              <Plus size={15} />
              授权 Agent
            </button>
          </div>
          <div className="connect-rows">
            {grants.map((g) => (
              <article className="connect-row" key={g.id}>
                <div className="connect-row-icon">
                  <KeyRound size={18} />
                </div>
                <div>
                  <strong>{g.name}</strong>
                  <p>
                    {g.policy.space_ids
                      .map((id) =>
                        id === "personal"
                          ? "个人空间"
                          : ws.spaces.find((s) => s.id === id)?.name ||
                            "团队空间",
                      )
                      .join("、")}{" "}
                    ·{" "}
                    {g.policy.dynamic_membership
                      ? "包含未来新增知识"
                      : `${g.policy.captured_item_ids?.length || 0} 条既有知识`}{" "}
                    · {g.policy.fields.map((f) => fieldNames[f]).join("、")}
                  </p>
                  <small>
                    {g.enabled && new Date(g.expires) > new Date()
                      ? `有效至 ${dateOf(g.expires)}`
                      : "已失效"}
                    {g.parent_client ? " · OAuth 客户端" : ""}
                  </small>
                </div>
                {g.enabled && (
                  <div className="connect-inline-actions">
                    {!g.parent_client && (
                      <button
                        className="text-button"
                        onClick={() =>
                          void knowledgeAPI<Grant>(
                            "grants/" + g.id + "/rotate",
                            {},
                          )
                            .then(created)
                            .catch((e) => notify(e.message))
                        }
                      >
                        轮换
                      </button>
                    )}
                    <button
                      className="quiet-button"
                      onClick={() => void revoke(g)}
                    >
                      撤销
                    </button>
                  </div>
                )}
              </article>
            ))}
            {!grants.length && (
              <div className="connect-empty small">
                <KeyRound size={22} />
                <p>从一个主题或几条记录开始授权</p>
              </div>
            )}
          </div>
          <div className="connect-setup">
            <h3>接入你常用的 Agent</h3>
            <div className="connect-two">
              <div>
                <strong>本地 MCP / CLI / Python SDK</strong>
                <p>
                  安装客户端后，把访问令牌放入环境变量或系统钥匙串。stdio
                  适合本地 Agent。
                </p>
                <code>
                  pip install -e ".[mcp,keychain]"
                  <br />
                  sediment mcp
                </code>
                <button
                  className="text-button"
                  onClick={() =>
                    download(
                      "沉淀-MCP配置.json",
                      JSON.stringify(
                        {
                          mcpServers: {
                            sediment: {
                              command: "sediment",
                              args: ["mcp"],
                              env: {
                                SEDIMENT_URL: cap?.api_url || location.origin,
                                SEDIMENT_TOKEN: "请在本地填入用户授予的令牌",
                              },
                            },
                          },
                        },
                        null,
                        2,
                      ),
                    )
                  }
                >
                  <ArrowDownToLine size={13} />
                  下载配置模板
                </button>
              </div>
              <div>
                <strong>远程 MCP / OAuth</strong>
                <p>
                  客户端连接后打开授权页，选择内容范围。OAuth
                  令牌带有资源限制，可随时撤销。
                </p>
                <code>{cap?.mcp_url || "读取服务地址中…"}</code>
                <small>
                  远程服务需同时运行独立 MCP 进程。当前页面不代表进程已启动。
                </small>
              </div>
            </div>
          </div>
        </>
      )}
      {tab === "destinations" && (
        <>
          <div className="connect-section-head">
            <div>
              <h3>你自己的知识工具</h3>
              <p>
                配置保存在当前浏览器；导出配置交给本地连接器。凭证使用环境变量或系统钥匙串引用。
              </p>
            </div>
            <button
              className="primary"
              onClick={() => setDialog("destination")}
            >
              <Plus size={15} />
              添加目的地
            </button>
          </div>
          {profiles.length ? (
            <div className="connect-rows">
              {profiles.map((p) => (
                <article className="connect-row" key={p.id}>
                  <div className="destination-mark">
                    {p.kind === "obsidian"
                      ? "O"
                      : p.kind === "feishu"
                        ? "飞"
                        : "i"}
                  </div>
                  <div>
                    <strong>{p.name}</strong>
                    <p>
                      {p.kind} · {p.target_id}
                    </p>
                    <small>
                      本地执行 ·{" "}
                      {p.kind === "obsidian"
                        ? "Markdown、附件、冲突保护"
                        : p.kind === "feishu"
                          ? "文档／知识库节点，保留新版本"
                          : "正式 OpenAPI，笔记／知识库"}
                    </small>
                  </div>
                  <div className="connect-inline-actions">
                    <button
                      className="quiet-button"
                      onClick={() => {
                        const { id, name, ...config } = p;
                        download(id + ".json", JSON.stringify(config, null, 2));
                        notify("已导出不含明文凭证的连接配置");
                      }}
                    >
                      <DownloadIcon />
                      配置
                    </button>
                    <button
                      className="icon-button"
                      aria-label={"移除目的地 " + p.name}
                      onClick={() => {
                        const next = profiles.filter((x) => x.id !== p.id);
                        setProfiles(next);
                        saveDestinations(ws.me.owner_id, next);
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div className="destination-command connect-code">
                    <code>
                      sediment connector configure {p.id} {p.id}.json
                    </code>
                    <code>sediment connector probe {p.id}</code>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="connect-empty">
              <Link2 size={25} />
              <h3>让知识回到常用的地方</h3>
              <p>Obsidian · 飞书文档与知识库 · ima</p>
              <p>
                保留来源、版本、理解和实践依据。连接器不会擅自覆盖外部修改。
              </p>
            </div>
          )}
          <div className="connect-setup">
            <h3>本地连接流程</h3>
            <ol>
              <li>
                下载目的地配置，使用上方对应的 configure
                命令保存到本机，保留配置标识。
              </li>
              <li>
                配置本机凭证引用，再运行「sediment connector probe
                配置名」检查读取权限。
              </li>
              <li>
                在知识详情中选择「提取与沉淀」，确认内容与目标。执行后在这里查看回执。
              </li>
            </ol>
            <p>
              Obsidian 支持安全更新托管笔记与附件；飞书和 ima
              创建新版本，当前不覆盖或删除原有文档。正式平台账号尚需你配置后验证。
            </p>
          </div>
        </>
      )}
      {tab === "operations" && <Operations />}
      {tab === "rules" && <Rules grants={grants} profiles={profiles} />}{" "}
      {tab === "audit" && <Audit />}
      {tab === "team" && (
        <TeamPolicy onService={() => setDialog("service")} />
      )}{" "}
      {dialog === "grant" && (
        <GrantDialog close={() => setDialog("")} created={created} />
      )}{" "}
      {dialog === "service" && (
        <GrantDialog service close={() => setDialog("")} created={created} />
      )}{" "}
      {dialog === "destination" && (
        <DestinationDialog
          close={() => setDialog("")}
          saved={(p) => {
            const next = [...profiles, p];
            setProfiles(next);
            saveDestinations(ws.me.owner_id, next);
            setDialog("");
            notify("目的地配置已保存在此浏览器");
          }}
        />
      )}
      {token?.token && (
        <TokenDialog
          token={token.token}
          name={token.name}
          close={() => setToken(null)}
        />
      )}
    </div>
  );
}
function DownloadIcon() {
  return <ArrowDownToLine size={14} />;
}
function DestinationDialog({
  close,
  saved,
}: {
  close: () => void;
  saved: (d: Destination) => void;
}) {
  const [kind, setKind] = useState<Destination["kind"]>("obsidian"),
    [name, setName] = useState("我的 Obsidian"),
    [config, setConfig] = useState<Record<string, string>>({
      target_id: "my-vault",
      vault: "",
      folder: "沉淀",
    });
  const changeKind = (kind: Destination["kind"]) => {
    setKind(kind);
    setName(
      kind === "obsidian"
        ? "我的 Obsidian"
        : kind === "feishu"
          ? "团队飞书"
          : "我的 ima",
    );
    setConfig(
      kind === "obsidian"
        ? { target_id: "my-vault", vault: "", folder: "沉淀" }
        : kind === "feishu"
          ? {
              target_id: "team-docs",
              app_id: "",
              app_secret: "env:FEISHU_APP_SECRET",
              folder_token: "",
              wiki_space: "",
              parent_node: "",
            }
          : {
              target_id: "my-ima",
              client_id: "",
              api_key: "env:IMA_API_KEY",
              mode: "note",
              folder_id: "",
              knowledge_base_id: "",
            },
    );
  };
  const names: Record<string, string> = {
    target_id: "目标标识（用于审批匹配）",
    vault: "本地 Obsidian 仓库完整路径",
    folder: "仓库内的沉淀目录",
    app_id: "飞书应用 App ID",
    app_secret: "App Secret 的本地引用",
    folder_token: "云文档文件夹 Token（可选）",
    wiki_space: "知识库 Space ID（可选）",
    parent_node: "知识库父节点 Token（可选）",
    client_id: "ima OpenAPI Client ID",
    api_key: "API Key 的本地引用",
    folder_id: "目的地文件夹 ID（可选）",
    knowledge_base_id: "ima 知识库 ID",
  };
  const valid =
    !!name.trim() &&
    !!config.target_id &&
    (kind === "obsidian"
      ? !!config.vault
      : kind === "feishu"
        ? !!config.app_id &&
          (config.app_secret.startsWith("env:") ||
            config.app_secret?.startsWith("keychain:"))
        : !!config.client_id &&
          (config.api_key.startsWith("env:") ||
            config.api_key.startsWith("keychain:")) &&
          (config.mode === "note" || !!config.knowledge_base_id));
  return (
    <Overlay title="添加沉淀目的地" onClose={close}>
      <div className="connect-flow">
        <p>
          这里只填写路径、目标 ID 与凭证引用。飞书、ima
          的密钥在本地连接器配置，不发送到知识系统服务器。
        </p>
        <label className="connect-field">
          目的地类型
          <select
            value={kind}
            onChange={(e) => changeKind(e.target.value as Destination["kind"])}
          >
            <option value="obsidian">Obsidian 本地仓库</option>
            <option value="feishu">飞书文档／知识库</option>
            <option value="ima">ima 笔记／知识库</option>
          </select>
        </label>
        <label className="connect-field">
          显示名称
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {kind === "ima" && (
          <label className="connect-field">
            导入方式
            <select
              value={config.mode}
              onChange={(e) => setConfig({ ...config, mode: e.target.value })}
            >
              <option value="note">个人笔记</option>
              <option value="kb_note">知识库中的笔记</option>
              <option value="kb_file">知识库中的 Markdown 文件</option>
            </select>
          </label>
        )}
        {Object.entries(config)
          .filter(([key]) => key !== "mode")
          .map(([key, value]) => (
            <label className="connect-field" key={key}>
              {names[key]}
              <input
                value={value}
                onChange={(e) =>
                  setConfig({ ...config, [key]: e.target.value })
                }
                placeholder={
                  key === "vault"
                    ? "/Users/你的用户名/Documents/知识库"
                    : undefined
                }
              />
            </label>
          ))}
        <button
          className="primary"
          disabled={!valid}
          onClick={() =>
            saved({
              id: newId(),
              name,
              kind,
              ...Object.fromEntries(
                Object.entries(config).filter(([, v]) => v),
              ),
            } as Destination)
          }
        >
          保存本地配置
        </button>
      </div>
    </Overlay>
  );
}
function Rules({
  grants,
  profiles,
}: {
  grants: Grant[];
  profiles: Destination[];
}) {
  const { notify } = useWorkspace(),
    [rules, setRules] = useState<
      {
        id: string;
        enabled: boolean;
        data: { target_id: string; destination: string; max_daily: number };
      }[]
    >([]),
    [grant, setGrant] = useState(""),
    [dest, setDest] = useState(""),
    [max, setMax] = useState(20),
    [include, setInclude] = useState(false),
    [consent, setConsent] = useState(false);
  const load = () =>
    knowledgeAPI<{ rules: typeof rules }>("rules")
      .then((d) => setRules(d.rules))
      .catch((e) => notify(e.message));
  useEffect(() => {
    void load();
  }, []);
  const create = async () => {
    const g = grants.find((g) => g.id === grant),
      p = profiles.find((p) => p.id === dest);
    if (!g || !p) return;
    try {
      await knowledgeAPI("rules", {
        grant_id: g.id,
        space_id: g.policy.space_ids[0],
        fields: g.policy.fields,
        destination: p.kind,
        target_id: p.target_id,
        max_daily: max,
        include_existing: include,
        enabled: true,
        allow_update: false,
      });
      await load();
      setConsent(false);
      notify("增量规则已启用");
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return (
    <section>
      <div className="connect-section-head">
        <div>
          <h3>按固定范围持续沉淀</h3>
          <p>
            只按你批准的范围、内容层次、目标和上限生成完整记录；Agent
            的改写稿仍需单独确认。
          </p>
        </div>
      </div>
      <div className="connect-rows">
        {rules.map((r) => (
          <article className="connect-row" key={r.id}>
            <RefreshCw size={17} />
            <div>
              <strong>
                {r.data.destination} · {r.data.target_id}
              </strong>
              <p>
                每日最多 {r.data.max_daily} 条 ·{" "}
                {r.enabled ? "已启用" : "已暂停"}
              </p>
            </div>
            <button
              className="quiet-button"
              onClick={() =>
                void knowledgeAPI("rules/" + r.id + "/toggle", {
                  enabled: !r.enabled,
                })
                  .then(load)
                  .catch((e) => notify(e.message))
              }
            >
              {r.enabled ? "暂停" : "启用"}
            </button>
          </article>
        ))}
      </div>
      <div className="connect-rule-form">
        <label className="connect-field">
          使用哪个授权
          <select value={grant} onChange={(e) => setGrant(e.target.value)}>
            <option value="">选择有效授权</option>
            {grants
              .filter(
                (g) =>
                  g.enabled &&
                  g.policy.scopes.includes("knowledge:export") &&
                  g.policy.scopes.includes("exports:run"),
              )
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
          </select>
        </label>
        <label className="connect-field">
          固定目的地
          <select value={dest} onChange={(e) => setDest(e.target.value)}>
            <option value="">选择本地目的地配置</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="connect-field">
          每日上限
          <input
            type="number"
            min="1"
            max="100"
            value={max}
            onChange={(e) => setMax(Number(e.target.value))}
          />
        </label>
        <label className="connect-check">
          <input
            type="checkbox"
            checked={include}
            onChange={(e) => setInclude(e.target.checked)}
          />
          首次也沉淀范围内的已有知识
        </label>
        <label className="connect-check">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          我批准按所选授权与固定目标自动生成完整记录
        </label>
        <button
          className="primary"
          disabled={!consent || !grant || !dest || max < 1 || max > 100}
          onClick={() => void create()}
        >
          创建增量规则
        </button>
        <div className="connect-code">
          <code>sediment connector watch</code>
        </div>
        <p className="connect-muted">
          本地连接器运行时执行；本机离线时，任务留在队列。不会上传浏览器 AI
          Key。
        </p>
      </div>
    </section>
  );
}
function Audit() {
  const { notify } = useWorkspace(),
    [events, setEvents] = useState<
      {
        id: string;
        action: string;
        allowed: boolean;
        at: string;
        grant_id?: string;
        refs: string[];
        request_id: string;
      }[]
    >([]);
  useEffect(() => {
    void knowledgeAPI<{ events: typeof events }>("audit")
      .then((d) => setEvents(d.events))
      .catch((e) => notify(e.message));
  }, []);
  return (
    <section>
      <div className="connect-section-head">
        <div>
          <h3>访问留下记录</h3>
          <p>记录操作、授权与条目引用；不记录原文、API Key 或外部凭证。</p>
        </div>
      </div>
      <div className="connect-rows">
        {events.map((e) => (
          <article className="connect-row" key={e.id}>
            <ShieldCheck size={16} />
            <div>
              <strong>{e.action}</strong>
              <p>
                {e.allowed ? "已允许" : "已拒绝"} · {dateOf(e.at)}
                {e.grant_id ? " · " + e.grant_id.slice(0, 8) : " · 用户操作"}
              </p>
              <small>请求 {e.request_id}</small>
            </div>
            <span className="tag">{e.refs.length} 个引用</span>
          </article>
        ))}
        {!events.length && <p className="connect-muted">暂无访问记录。</p>}
      </div>
    </section>
  );
}
function TeamPolicy({ onService }: { onService: () => void }) {
  const { ws, notify } = useWorkspace(),
    teams = ws.spaces.filter((s) => s.role === "owner" || s.role === "admin"),
    [space, setSpace] = useState(teams[0]?.id || ""),
    [policy, setPolicy] = useState({
      allow_read: false,
      allow_export: false,
      allowed_destinations: [] as string[],
    }),
    [services, setServices] = useState<
      { id: string; name: string; grants: Grant[] }[]
    >([]);
  const load = () => {
    if (space) {
      void knowledgeAPI<typeof policy>("policies/" + space)
        .then(setPolicy)
        .catch((e) => notify(e.message));
      void knowledgeAPI<{ accounts: typeof services }>(
        "service-accounts?space_id=" + space,
      )
        .then((d) => setServices(d.accounts))
        .catch((e) => notify(e.message));
    }
  };
  useEffect(load, [space]);
  if (!teams.length)
    return (
      <div className="connect-empty">
        <ShieldCheck size={25} />
        <h3>团队管理员管理外部访问</h3>
        <p>
          团队知识默认不开放给外部
          Agent，也不允许外发。加入或创建团队后，由管理员按需开启。
        </p>
      </div>
    );
  return (
    <section>
      <div className="connect-section-head">
        <div>
          <h3>团队的边界，由团队决定</h3>
          <p>
            成员只能在管理员允许的范围内授权自己的
            Agent。关闭外部访问后，已有授权立即失效于该团队。
          </p>
        </div>
      </div>
      <label className="connect-field">
        团队
        <select value={space} onChange={(e) => setSpace(e.target.value)}>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label className="connect-check">
        <input
          type="checkbox"
          checked={policy.allow_read}
          onChange={(e) =>
            setPolicy({ ...policy, allow_read: e.target.checked })
          }
        />
        允许成员为外部 Agent 授权团队知识
      </label>
      <label className="connect-check">
        <input
          type="checkbox"
          checked={policy.allow_export}
          onChange={(e) =>
            setPolicy({ ...policy, allow_export: e.target.checked })
          }
        />
        允许将授权知识沉淀到外部工具
      </label>
      <div className="connect-checkbox-grid">
        {["obsidian", "feishu", "ima", "portable"].map((d) => (
          <label key={d}>
            <input
              type="checkbox"
              checked={policy.allowed_destinations.includes(d)}
              onChange={() =>
                setPolicy({
                  ...policy,
                  allowed_destinations: changeList(
                    policy.allowed_destinations,
                    d,
                  ),
                })
              }
            />
            {d === "portable" ? "本地下载" : d}
          </label>
        ))}
      </div>
      <button
        className="primary"
        onClick={() =>
          void knowledgeAPI("policies/" + space, policy)
            .then(() => notify("团队外部策略已保存"))
            .catch((e) => notify(e.message))
        }
      >
        保存团队策略
      </button>
      <div className="connect-section-head">
        <div>
          <h3>团队服务账号</h3>
          <p>为团队工作流建立独立身份，阅读或编辑角色均受团队权限约束。</p>
        </div>
        <button className="quiet-button" onClick={onService}>
          <Plus size={14} />
          创建服务账号
        </button>
      </div>
      <div className="connect-rows">
        {services.map((s) => (
          <article className="connect-row" key={s.id}>
            <KeyRound size={16} />
            <div>
              <strong>{s.name}</strong>
              <p>{s.grants.length} 个授权</p>
            </div>
            <button
              className="quiet-button"
              onClick={() =>
                void knowledgeAPI("service-accounts/" + s.id + "/disable", {})
                  .then(() => {
                    notify("服务账号已停用");
                    load();
                  })
                  .catch((e) => notify(e.message))
              }
            >
              停用
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
export function OAuthConsent({ id }: { id: string }) {
  const { notify } = useWorkspace(),
    [info, setInfo] = useState<{
      client_name: string;
      redirect_uri: string;
      resource: string;
      scopes: string[];
    } | null>(null),
    [policy, setPolicy] = useState<Policy>(defaults),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    void knowledgeAPI<NonNullable<typeof info>>("oauth/" + id + "/context")
      .then((i) => {
        setInfo(i);
        setPolicy({
          ...defaults,
          scopes: i.scopes.filter((s) =>
            ["knowledge:read", "proposals:create"].includes(s),
          ),
        });
      })
      .catch((e) => setError(e.message));
  }, [id]);
  const consent = async (approve: boolean) => {
    setBusy(true);
    try {
      const result = await knowledgeAPI<{ redirect_url: string }>(
        "oauth/" + id + "/consent",
        { approve, policy },
      );
      location.assign(result.redirect_url);
    } catch (e) {
      notify((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <main className="oauth-consent">
      <BrandMark />
      <span className="small-label">沉淀 · Agent 授权</span>
      <h1>
        {info ? `让「${info.client_name}」访问指定知识` : "正在读取授权请求"}
      </h1>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        info && (
          <>
            <p>
              选择知识范围与权限。客户端不能自行采纳建议或批准外发；你可以在连接设置中撤销授权。
            </p>
            <div className="oauth-client-details">
              <span>资源</span>
              <code>{info.resource}</code>
              <span>回调</span>
              <code>{info.redirect_uri}</code>
            </div>
            <ScopeForm
              policy={policy}
              set={setPolicy}
              requestedScopes={info.scopes}
            />
            <div className="connect-footer">
              <button
                className="quiet-button"
                disabled={busy}
                onClick={() => void consent(false)}
              >
                拒绝
              </button>
              <button
                className="primary"
                disabled={busy || !policy.fields.length}
                onClick={() => void consent(true)}
              >
                允许所选范围
              </button>
            </div>
          </>
        )
      )}
    </main>
  );
}
