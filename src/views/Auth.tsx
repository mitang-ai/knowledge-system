import { ArrowRight, LockKeyhole } from "lucide-react";
import { useState, type FormEvent } from "react";
import { BrandMark } from "../Brand";
import { api } from "../lib";

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
  const submit = async (e: FormEvent) => {
    e.preventDefault();
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
          {register
            ? initialRegister
              ? "启用你的知识账号"
              : "创建个人知识空间"
            : "回到你的知识空间"}
        </h2>
        <p>
          {register
            ? "个人内容默认仅自己可见，之后可以加入团队。"
            : "用邮箱与密码登录这个本地实例。"}
        </p>
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
            邮箱
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
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
            onClick={() => {
              setRegister(!register);
              setError("");
            }}
          >
            {register ? "已有账号，去登录" : "没有账号，创建一个个人空间"}
            <ArrowRight size={13} />
          </button>
        )}
        <div className="auth-local">
          <LockKeyhole size={13} />
          账号保存在此实例，未连接旧线上账号
        </div>
      </div>
    </div>
  );
}
