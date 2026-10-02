import { Check, Copy, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, colors, newItem, titleOf } from "../lib";

import { roleLabel } from "../lib";
import { Overlay } from "../ui";
import { useWorkspace, type Dialog } from "../workspace";
import { Login } from "./Auth";
import { templates } from "./Knowledge";
export function DialogView({
  dialog,
  close,
}: {
  dialog: NonNullable<Dialog>;
  close: () => void;
}) {
  const { ws, space, topics, save, refresh, notify } = useWorkspace();
  const [name, setName] = useState(
      dialog.type === "topic" ? dialog.item?.title || "" : "",
    ),
    [description, setDescription] = useState(
      dialog.type === "topic" ? dialog.item?.body || "" : "",
    ),
    [color, setColor] = useState(
      dialog.type === "topic" ? dialog.item?.color || colors[0] : colors[0],
    ),
    [target, setTarget] = useState(""),
    [role, setRole] = useState("editor"),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const titles = {
    topic: dialog.type === "topic" && dialog.item ? "编辑主题" : "新建主题",
    merge: "合并主题",
    space: "创建团队空间",
    join: "加入团队空间",
    invite: "邀请团队成员",
    account: "启用账号登录",
    templates: "记录模板",
    shortcuts: "键盘快捷键",
    confirm: dialog.type === "confirm" ? dialog.title : "",
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (dialog.type === "topic") {
        await save({
          ...(dialog.item ||
            newItem("topic", ws.me.owner_id, ws.me.display_name)),
          title: name.trim(),
          body: description.trim(),
          color,
          space_id: space || null,
        });
        notify(dialog.item ? "主题已更新" : "主题已创建");
      } else if (dialog.type === "space") {
        await api("spaces", { name, description });
        await refresh();
        notify("团队空间已创建，可从左侧切换");
      } else if (dialog.type === "join") {
        await api("join", { code });
        await refresh();
        notify("已加入团队空间");
      } else if (dialog.type === "invite") {
        const result = await api<{ code: string }>("invites", { space, role });
        setCode(result.code);
        setBusy(false);
        return;
      } else if (dialog.type === "merge") {
        await api("merge-topics", { source: dialog.item.id, target });
        await refresh();
        notify("主题已合并，内容关联已更新");
      } else if (dialog.type === "confirm") {
        await dialog.action();
      }
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Overlay title={titles[dialog.type]} onClose={close}>
      {dialog.type === "account" ? (
        <Login
          initialRegister
          inModal
          onSuccess={async () => {
            await refresh();
            close();
            notify("账号登录已启用，原内容保留在当前个人空间");
          }}
        />
      ) : dialog.type === "shortcuts" ? (
        <div className="shortcut-list">
          {[
            ["搜索所有知识", "⌘ / Ctrl + K"],
            ["开始一条新记录", "N"],
            ["保存记录或补充", "⌘ / Ctrl + Enter"],
            ["关闭浮层", "Esc"],
          ].map(([a, b]) => (
            <div key={a}>
              <span>{a}</span>
              <kbd>{b}</kbd>
            </div>
          ))}
        </div>
      ) : dialog.type === "templates" ? (
        <div>
          {templates.map((t) => (
            <div key={t.name}>
              <h3>{t.name}</h3>
              <p>{t.description}</p>
            </div>
          ))}
        </div>
      ) : (
        <form className="dialog-form" onSubmit={submit}>
          {dialog.type === "topic" && (
            <>
              <p className="dialog-description">
                主题是长期关注的方向。一条记录可以连接多个主题。
              </p>
              <label>
                主题名称
                <input
                  autoFocus
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：产品与设计"
                  maxLength={80}
                />
              </label>
              <label>
                主题说明
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="这个主题收什么内容？有什么边界？"
                  rows={3}
                />
              </label>
              <label>
                主题标记
                <div className="color-picks">
                  {colors.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={"选择颜色 " + c}
                      style={{ background: c }}
                      onClick={() => setColor(c)}
                    >
                      {color === c && <Check size={16} />}
                    </button>
                  ))}
                </div>
              </label>
            </>
          )}
          {dialog.type === "space" && (
            <>
              <p className="dialog-description">
                团队知识与个人记录独立。通过邀请添加成员，为团队沉淀方法与经验。
              </p>
              <label>
                空间名称
                <input
                  autoFocus
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：产品工作室"
                  maxLength={80}
                />
              </label>
              <label>
                空间说明
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="我们在这里共同积累什么？"
                  rows={3}
                />
              </label>
              <div className="info-strip">
                <ShieldCheck size={15} />
                你将成为空间所有者，可以管理成员角色。
              </div>
            </>
          )}
          {dialog.type === "join" && (
            <>
              <p className="dialog-description">
                请向团队所有者或管理员获取邀请码。加入后，你的个人记录仍仅自己可见。
              </p>
              <label>
                邀请码
                <input
                  autoFocus
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="粘贴团队邀请码"
                />
              </label>
            </>
          )}
          {dialog.type === "invite" && (
            <>
              <p className="dialog-description">
                邀请码有效期 7
                天，只能使用一次。将它复制给希望邀请的人，对方注册并登录后即可加入。
              </p>
              {code ? (
                <div className="invitation-code">
                  <span>邀请角色 · {roleLabel(role)}</span>
                  <code>{code}</code>
                  <button
                    type="button"
                    className="primary"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(code)
                        .then(() => notify("邀请码已复制"))
                        .catch(() => notify("可以直接选中邀请码复制"))
                    }
                  >
                    <Copy size={14} />
                    复制邀请码
                  </button>
                </div>
              ) : (
                <label>
                  邀请角色
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                  >
                    <option value="editor">编辑成员 · 可以记录和补充</option>
                    <option value="viewer">只读成员 · 只能阅读</option>
                    {ws.spaces.find((s) => s.id === space)?.role ===
                      "owner" && (
                      <option value="admin">管理员 · 可以邀请成员</option>
                    )}
                  </select>
                </label>
              )}
            </>
          )}
          {dialog.type === "merge" && (
            <>
              <p className="dialog-description">
                将「{titleOf(dialog.item)}
                」的关联内容转入另一个主题。原主题进入回收站，正文和补充保持原有归属，所有关联变更留存历史。
              </p>
              <label>
                合并到
                <select
                  required
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="">选择目标主题</option>
                  {topics
                    .filter((t) => t.id !== dialog.item.id)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {titleOf(t)}
                      </option>
                    ))}
                </select>
              </label>
            </>
          )}
          {dialog.type === "confirm" && (
            <p className="dialog-description">{dialog.message}</p>
          )}
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="form-actions">
            <button type="button" className="quiet-button" onClick={close}>
              {code && dialog.type === "invite" ? "完成" : "取消"}
            </button>
            {!(code && dialog.type === "invite") && (
              <button className="primary" disabled={busy}>
                {busy
                  ? "正在保存…"
                  : dialog.type === "invite"
                    ? "生成邀请码"
                    : dialog.type === "confirm"
                      ? "确认操作"
                      : dialog.type === "join"
                        ? "加入空间"
                        : dialog.type === "merge"
                          ? "确认合并"
                          : "保存"}
                <Check size={15} />
              </button>
            )}
          </div>
        </form>
      )}
    </Overlay>
  );
}
