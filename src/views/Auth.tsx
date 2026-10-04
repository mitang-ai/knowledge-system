import { ArrowRight, Copy, Download, LockKeyhole, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { BrandMark } from "../Brand";
import { api } from "../lib";
import { credentialsText, generateCredentials, type QuickCredentials } from "../auth/credentials";

export function Login({
  onSuccess,
  initialRegister = false,
  inModal = false,
}: {
  onSuccess: () => Promise<void>;
  initialRegister?: boolean;
  inModal?: boolean;
}) {
  const [register, setRegister] = useState(initialRegister),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [quick, setQuick] = useState<QuickCredentials | null>(null);
  const [created, setCreated] = useState(false);
  const [saved, setSaved] = useState(false);
  const [feedback, setFeedback] = useState("");
  const inFlight = useRef(false);
  useEffect(() => {
    if (!quick || saved) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [quick, saved]);
  const createQuick = async (mode: "register" | "login" = "register") => {
    if (inFlight.current || created) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const credentials = quick || generateCredentials();
      setQuick(credentials);
      await api(mode, { ...credentials, display_name: name.trim() || "新的思考者" });
      setCreated(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const enterQuick = async () => {
    if (!created || !saved || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await onSuccess();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const copyQuick = async () => {
    if (!quick) return;
    try {
      await navigator.clipboard.writeText(credentialsText(quick, location.origin));
      setFeedback("账密已复制，请保存到安全的位置；剪贴板中含明文密码。");
    } catch {
      setFeedback("复制不可用，请选中下方账密手动复制，或下载保存卡。");
    }
  };
  const downloadQuick = () => {
    if (!quick) return;
    try {
      const url = URL.createObjectURL(new Blob([credentialsText(quick, location.origin)], { type: "text/plain;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `sediment-account-${quick.email.split("@")[0]}.txt`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setFeedback("已发起下载。文件含明文密码，请确认下载完成并移到安全的位置。");
    } catch {
      setFeedback("下载不可用，请手动复制账密并妥善保存。");
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await api(register ? "register" : "login", {
        email,
        password,
        display_name: name,
      });
      await onSuccess();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <div className={inModal ? "auth-inline" : "auth-page"}>
      {!inModal && (
        <div className="auth-story">
          <div className="sidebar-brand">
            <BrandMark />
            <span>沉淀</span>
          </div>
          <div>
            <span className="eyebrow">个人的思考，团队的积累。</span>
            <h1>
              给你的知识，
              <br />
              留一个长久的位置。
            </h1>
            <p>记录当下，连接想法，慢慢形成自己的理解。</p>
          </div>
          <span className="small-label">A PLACE FOR YOUR THOUGHTS</span>
        </div>
      )}
      <div className="auth-card">
        <span className="auth-icon">
          <BrandMark />
        </span>
        <h2>
          {quick ? created ? "账号已创建，请先保存" : "保存这组账号和密码" : register
            ? initialRegister
              ? "启用你的知识账号"
              : "创建个人知识空间"
            : "回到你的知识空间"}
        </h2>
        <p>
          {quick ? "账密仅在当前页面展示，请勿在保存前刷新或关闭页面。" : register
            ? "个人内容默认仅自己可见，之后可以加入团队。"
            : "用邮箱或自动生成的账号与密码登录。"}
        </p>
        <div className="auth-safety">
          <LockKeyhole size={15} aria-hidden="true" />
          <div><strong>请妥善保管自己的账号和密码</strong><p>不要分享给他人，建议存入密码管理器。自动生成的账号不是邮箱，不能接收邮件；丢失账密可能无法找回。</p></div>
        </div>
        {quick ? (
          <section className="auth-credentials" aria-label="账号保存卡" aria-busy={busy}>
            <label>登录账号（非邮箱）<input value={quick.email} readOnly autoComplete="off" autoFocus onFocus={(e) => e.target.select()} /></label>
            <label>密码（请保存）<input value={quick.password} readOnly autoComplete="off" spellCheck={false} onFocus={(e) => e.target.select()} /></label>
            <p className="auth-credentials-hint">此处显示明文密码，请注意周围环境。系统不保存明文密码，此页面不会将账密写入浏览器存储。</p>
            <div className="auth-save-actions">
              <button type="button" className="quiet-button" onClick={() => void copyQuick()}><Copy size={14} />复制账密</button>
              <button type="button" className="quiet-button" onClick={downloadQuick}><Download size={14} />下载保存卡</button>
            </div>
            <p className="auth-save-feedback" role="status">{feedback || (busy ? "正在处理，请稍候…" : created ? "账号已创建并登录，保存后即可进入空间。" : "创建未确认。请保留这组账密，重试或尝试登录。")}</p>
            {error && <div className="form-error" role="alert">{error}</div>}
            {created ? <>
              <label className="auth-save-confirm"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} disabled={busy} />我已妥善保存账号和密码</label>
              <button type="button" className="primary auth-wide" disabled={busy || !saved} onClick={() => void enterQuick()}>{busy ? "请稍候…" : "进入我的知识空间"}<ArrowRight size={15} /></button>
            </> : <div className="auth-retry-actions">
              <button type="button" className="primary auth-wide" disabled={busy} onClick={() => void createQuick()}>{busy ? "请稍候…" : "重试创建这组账号"}</button>
              <button type="button" className="text-button" disabled={busy} onClick={() => void createQuick("login")}>若已创建，用这组账密登录</button>
            </div>}
          </section>
        ) : <>
        <button type="button" className="quiet-button auth-quick auth-wide" disabled={busy} onClick={() => void createQuick()}><WandSparkles size={15} />一键创建账号密码</button>
        <div className="auth-divider"><span>或手动{register ? "注册" : "登录"}</span></div>
        <form onSubmit={submit}>
          {register && (
            <label>
              显示名
              <input
                value={name}
                required
                onChange={(e) => setName(e.target.value)}
                placeholder="你希望如何署名"
                autoComplete="nickname"
                maxLength={40}
              />
            </label>
          )}
          <label>
            {register ? "邮箱" : "邮箱 / 登录账号"}
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="username"
            />
          </label>
          <label>
            密码
            <input
              type="password"
              required
              minLength={register ? 8 : 1}
              maxLength={200}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={register ? "至少 8 位" : "输入你的密码"}
              autoComplete={register ? "new-password" : "current-password"}
            />
          </label>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <button className="primary" disabled={busy}>
            {busy ? "请稍候…" : register ? "创建账号" : "登录"}
            <ArrowRight size={15} />
          </button>
        </form>
        {!initialRegister && (
          <button
            className="text-button auth-toggle"
            disabled={busy}
            onClick={() => {
              setRegister(!register);
              setError("");
            }}
          >
            {register ? "已有账号，去登录" : "没有账号，创建一个个人空间"}
            <ArrowRight size={13} />
          </button>
        )}
        </>}
        <div className="auth-local">
          <LockKeyhole size={13} />
          账号仅用于此站点，密码仅以哈希形式保存
        </div>
      </div>
    </div>
  );
}
