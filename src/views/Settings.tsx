import {
  AlertCircle,
  Archive,
  Check,
  Link2,
  LockKeyhole,
  LogOut,
  Monitor,
  MessageSquare,
  Moon,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sun,
  Type,
  UserPlus,
  Users,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, defaultPrefs, fonts, loadFont } from "../lib";
import type { Preferences } from "../types";

import { roleLabel } from "../lib";
import { PageHeading, SectionTitle } from "../ui";
import { useWorkspace } from "../workspace";
import { AISettings } from "../ai/Settings";
export function SettingsView({ initialTab = "type" }: { initialTab?: string }) {
  const { ws, prefs, settings, notify, dialog, refresh } = useWorkspace();
  const [tab, setTab] = useState(initialTab),
    [name, setName] = useState(ws.me.display_name);
  useEffect(() => { setTab(initialTab); }, [initialTab]);
  useEffect(() => {
    if (tab === "type") fonts.forEach((f) => loadFont(f.id));
  }, [tab]);
  const change = (value: Partial<Preferences>) =>
    settings({ ...prefs, ...value });
  return (
    <>
      <PageHeading
        title="让空间适合你"
        eyebrow="偏好设置"
        description="调整阅读与书写的节奏。排版更改即时预览；AI 配置单独保存在浏览器。"
        actions={
          <button
            className="quiet-button"
            onClick={() => {
              settings(defaultPrefs);
              notify("已恢复默认排版");
            }}
          >
            <RotateCcw size={14} />
            恢复默认
          </button>
        }
      />
      <div className="settings-tabs filter-tabs bordered-tabs">
        {[
          { id: "type", name: "字体与排版", icon: Type },
          { id: "appearance", name: "外观", icon: Sun },
          { id: "ai", name: "AI 与模型", icon: MessageSquare },
          { id: "account", name: "账号与空间", icon: Users },
          { id: "integration", name: "连接与迁移", icon: Link2 },
        ].map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "selected" : ""}
            onClick={() => setTab(t.id)}
          >
            <t.icon size={15} />
            {t.name}
          </button>
        ))}
      </div>
      {tab === "ai" && <AISettings />}
      {tab === "type" && (
        <div className="typography-layout">
          <div className="type-controls">
            <div className="setting-section">
              <h2>阅读字体</h2>
              <p>十种公开开源字体，随项目提供。</p>
              <div className="font-grid">
                {fonts.map((f) => (
                  <button
                    key={f.id}
                    className={
                      "font-option " + (prefs.font === f.id ? "selected" : "")
                    }
                    onClick={() => change({ font: f.id })}
                  >
                    <div>
                      <strong>{f.name}</strong>
                      {prefs.font === f.id && <Check size={15} />}
                    </div>
                    <span
                      style={{
                        fontFamily: `"${f.family}","Noto Sans SC",sans-serif`,
                      }}
                    >
                      {f.sample}
                    </span>
                    <small>{f.kind}</small>
                  </button>
                ))}
              </div>
              <p className="font-note">
                拉丁字体的中文部分搭配思源黑体；文楷使用含简体字的 TC
                开源版本。均遵循 SIL Open Font License。
              </p>
            </div>
            <div className="setting-section">
              <h2>阅读排版</h2>
              <Range
                label="正文字号"
                value={prefs.size}
                min={13}
                max={28}
                unit="px"
                change={(v) => change({ size: v })}
              />
              <Range
                label="正文行距"
                value={prefs.lineHeight}
                min={1.4}
                max={2.4}
                step={0.1}
                unit="倍"
                change={(v) => change({ lineHeight: v })}
              />
              <Range
                label="阅读宽度"
                value={prefs.width}
                min={520}
                max={900}
                step={20}
                unit="px"
                change={(v) => change({ width: v })}
              />
              <Range
                label="界面字号"
                value={prefs.uiSize}
                min={13}
                max={18}
                unit="px"
                change={(v) => change({ uiSize: v })}
              />
              <Range
                label="页面标题"
                value={prefs.headingSize}
                min={26}
                max={42}
                unit="px"
                change={(v) => change({ headingSize: v })}
              />
            </div>
          </div>
          <aside className="type-preview">
            <div className="preview-header">
              <span className="status-dot" />
              实时阅读预览<span>Aa</span>
            </div>
            <div className="preview-paper" style={{ maxWidth: prefs.width }}>
              <span className="small-label">关于知识的积累</span>
              <h2 style={{ fontSize: prefs.headingSize }}>
                把理解，写成自己的话
              </h2>
              <div className="preview-meta">阅读札记 · 2026 年 10 月 2 日</div>
              <div className="prose">
                <p>
                  记录一个想法很容易，真正的积累发生在之后：重新阅读，建立联系，尝试把它用在具体的事情里。
                </p>
                <p>
                  同一段话，在不同的阶段会有不同的理解。保留这种变化，比追求一次写得完整更有价值。
                </p>
                <blockquote>
                  知识不是收藏的数量，而是需要时能找到、能理解、能使用的东西。
                </blockquote>
                <h3>从记录到经验</h3>
                <p>
                  写下适用的场景，也写下它的边界。下一次遇到类似问题，过去的自己就能帮上一点忙。
                </p>
                <p className="latin-preview">
                  Good ideas deserve a second look.
                  <br />
                  0123456789 · Aa Bb Cc
                </p>
              </div>
            </div>
            <div className="preview-footer">
              {fonts.find((f) => f.id === prefs.font)?.name} · {prefs.size}px ·
              行距 {prefs.lineHeight}
            </div>
          </aside>
        </div>
      )}
      {tab === "appearance" && (
        <div className="appearance-settings">
          <SettingBlock
            title="界面主题"
            description="选择浅色、深色，或跟随设备设置。"
          >
            <div className="theme-options">
              {[
                { id: "light", name: "浅色", icon: Sun },
                { id: "dark", name: "深色", icon: Moon },
                { id: "system", name: "跟随系统", icon: Monitor },
              ].map((t) => (
                <button
                  key={t.id}
                  className={prefs.theme === t.id ? "selected" : ""}
                  onClick={() =>
                    change({ theme: t.id as Preferences["theme"] })
                  }
                >
                  <div className={"theme-mini theme-" + t.id}>
                    <span />
                    <div>
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                  <span>
                    <t.icon size={14} />
                    {t.name}
                    {prefs.theme === t.id && <Check size={14} />}
                  </span>
                </button>
              ))}
            </div>
          </SettingBlock>
          <SettingBlock title="黑白界面" description="以文字、线条和留白区分层次。深浅色开关始终位于页面右上角。">
            <div className="monochrome-swatch"><span /><span /><span /><span /></div>
          </SettingBlock>
          <SettingBlock
            title="界面密度"
            description="调整列表留白，阅读排版保持独立。"
          >
            <div className="segmented">
              <button
                className={prefs.density === "comfortable" ? "selected" : ""}
                onClick={() => change({ density: "comfortable" })}
              >
                舒展
              </button>
              <button
                className={prefs.density === "compact" ? "selected" : ""}
                onClick={() => change({ density: "compact" })}
              >
                紧凑
              </button>
            </div>
          </SettingBlock>
          <SettingBlock
            title="减少动效"
            description="使用更安静的页面切换，也尊重系统的减少动态效果设置。"
          >
            <button
              role="switch"
              aria-checked={!prefs.motion}
              className={"switch " + (!prefs.motion ? "on" : "")}
              onClick={() => change({ motion: !prefs.motion })}
            >
              <span />
            </button>
          </SettingBlock>
        </div>
      )}
      {tab === "account" && (
        <div className="account-settings">
          <SettingBlock
            title="你的显示名"
            description="用于内容署名，不会改变记录归属。"
          >
            <form
              className="inline-form"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api("profile", { display_name: name });
                  await refresh();
                  notify("显示名已更新");
                } catch (e) {
                  notify((e as Error).message);
                }
              }}
            >
              <input
                aria-label="显示名"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
              />
              <button className="quiet-button">保存</button>
            </form>
          </SettingBlock>
          <SettingBlock
            title={ws.account_enabled ? "账号已启用" : "本地个人模式"}
            description={
              ws.account_enabled
                ? "账号之间的个人内容互相隔离，团队内容按成员权限访问。"
                : "为当前工作空间设置邮箱与密码后，即可在此实例创建其他账号。旧账号密码不会自动迁入。"
            }
          >
            <button
              className="quiet-button"
              onClick={() =>
                ws.account_enabled
                  ? void api("logout", {})
                      .then(refresh)
                      .catch((e) => notify(e.message))
                  : dialog({ type: "account" })
              }
            >
              {ws.account_enabled ? (
                <>
                  <LogOut size={15} />
                  退出登录
                </>
              ) : (
                <>
                  <LockKeyhole size={15} />
                  启用账号登录
                </>
              )}
            </button>
          </SettingBlock>
          <div className="setting-section">
            <SectionTitle
              title="你加入的团队"
              count={ws.spaces.length}
              action={
                <button
                  className="quiet-button"
                  onClick={() => dialog({ type: "space" })}
                >
                  <Plus size={14} />
                  创建团队空间
                </button>
              }
            />
            {ws.spaces.length ? (
              ws.spaces.map((s) => (
                <div className="space-settings-row" key={s.id}>
                  <span className="workspace-avatar">
                    <Users size={17} />
                  </span>
                  <div>
                    <strong>{s.name}</strong>
                    <p>{s.description || "团队共同维护的知识空间"}</p>
                  </div>
                  <span className="tag">{roleLabel(s.role)}</span>
                </div>
              ))
            ) : (
              <p className="muted">创建团队后，可以通过邀请码添加成员。</p>
            )}
            <button
              className="text-button"
              onClick={() => dialog({ type: "join" })}
            >
              <UserPlus size={15} />
              使用邀请码加入团队
            </button>
          </div>
        </div>
      )}
      {tab === "integration" && (
        <div className="integration-settings">
          <div className="integration-card">
            <div className="integration-symbol">
              <Archive size={23} />
            </div>
            <div>
              <h3>可迁移的数据</h3>
              <p>
                Markdown 用于阅读；JSON
                保留结构；完整归档包含当前本地附件与缺失文件清单。备份恢复在管理工作台进行。
              </p>
            </div>
            <span className="tag green-tag">已可用</span>
          </div>
          <div className="integration-card">
            <div className="integration-symbol">
              <Link2 size={23} />
            </div>
            <div>
              <h3>飞书同步</h3>
              <p>
                原交付包的增量同步脚本已保留。新版提供可导出数据；飞书连接尚未配置，不会显示虚假的同步状态。
              </p>
            </div>
            <span className="tag">待对接</span>
          </div>
          <div className="integration-card">
            <div className="integration-symbol">
              <ShieldCheck size={23} />
            </div>
            <div>
              <h3>原云端系统</h3>
              <p>
                此版本在本地独立运行。原站点、原数据库和账号没有被修改；正式上线需部署认证服务、数据库与对象存储。
              </p>
            </div>
            <span className="tag">独立保存</span>
          </div>
          <div className="info-strip">
            <AlertCircle size={16} />
            交付包缺少原附件文件本体，六个历史引用已保留。
          </div>
        </div>
      )}
    </>
  );
}
export function Range({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  change,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  change: (v: number) => void;
}) {
  return (
    <label className="range-setting">
      <div>
        <span>{label}</span>
        <div>
          <input
            aria-label={label + "数值"}
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v >= min && v <= max) change(v);
            }}
          />
          {unit}
        </div>
      </div>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => change(Number(e.target.value))}
      />
    </label>
  );
}
export function SettingBlock({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-block">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div>{children}</div>
    </div>
  );
}
