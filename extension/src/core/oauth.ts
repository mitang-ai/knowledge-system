import { serviceOrigin } from "./capture";
import { SystemError, systemRequest } from "./system-client";
import type { AuthSession, Capabilities } from "../types";

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
export async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  return {
    verifier,
    challenge,
    state: base64url(crypto.getRandomValues(new Uint8Array(24))),
  };
}
export function checkCallback(value: string, redirect: string, state: string) {
  const actual = new URL(value),
    expected = new URL(redirect);
  if (
    actual.origin !== expected.origin ||
    actual.pathname !== expected.pathname ||
    actual.searchParams.get("state") !== state
  )
    throw new Error("授权回调或 state 不匹配，已停止连接。");
  if (actual.searchParams.has("error"))
    throw new Error("你未批准这次连接；没有获得访问权。");
  const code = actual.searchParams.get("code");
  if (!code) throw new Error("系统没有返回授权码。");
  return code;
}
async function oauthJSON<T>(
  origin: string,
  path: string,
  body?: unknown,
): Promise<T> {
  origin = serviceOrigin(origin);
  let r: Response;
  try {
    r = await fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new SystemError(
      "未收到授权服务的确认，请检查网络。不要反复批准新授权。",
    );
  }
  if (!r.ok)
    throw new SystemError(
      "授权未完成（HTTP " + r.status + "）。检查授权资源与系统设置。",
      r.status,
    );
  return r.json();
}
interface TokenReply {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}
export function bindSession(
  origin: string,
  token: string,
  cap: Capabilities,
): AuthSession {
  if (
    !cap.subject ||
    !cap.grant_id ||
    !Array.isArray(cap.scopes) ||
    !Array.isArray(cap.spaces)
  )
    throw new Error("需要独立范围授权；不能使用账号密码或管理员会话。");
  return {
    origin: serviceOrigin(origin),
    subject: cap.subject,
    grantId: cap.grant_id,
    scopes: cap.scopes,
    spaces: cap.spaces,
    accessToken: token,
    resource: cap.resource,
    expiresAt: cap.expires_at,
  };
}
export async function connectToken(origin: string, token: string) {
  if (!token.trim() || token.length > 2000)
    throw new Error("填写系统生成的范围授权令牌，不是登录密码或 AI Key。");
  return bindSession(
    origin,
    token.trim(),
    await systemRequest<Capabilities>(
      origin,
      "/api/v1/capabilities",
      token.trim(),
    ),
  );
}
export async function connectOAuth(
  origin: string,
  resource: string,
  redirect: string,
  authorize: (url: string) => Promise<string>,
) {
  origin = serviceOrigin(origin);
  if (!resource || resource.length > 2000)
    throw new Error("授权资源地址无效。");
  const meta = await oauthJSON<Record<string, unknown>>(
    origin,
    "/.well-known/oauth-authorization-server",
  );
  if (
    meta.issuer !== origin + "/" ||
    meta.authorization_endpoint !== origin + "/oauth/authorize" ||
    meta.token_endpoint !== origin + "/oauth/token" ||
    meta.registration_endpoint !== origin + "/oauth/register"
  )
    throw new Error("授权服务的端点不属于这个系统，已停止连接。");
  const { client_id: clientId } = await oauthJSON<{ client_id: string }>(
    origin,
    "/oauth/register",
    {
      client_name: "沉淀 · 随手记",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
    },
  );
  if (typeof clientId !== "string") throw new Error("系统没有注册这个客户端。");
  const pair = await pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: pair.challenge,
    code_challenge_method: "S256",
    state: pair.state,
    resource,
    scope: "knowledge:read proposals:create knowledge:write",
  });
  const callback = await authorize(origin + "/oauth/authorize?" + query);
  const code = checkCallback(callback, redirect, pair.state);
  const tokens = await oauthJSON<TokenReply>(origin, "/oauth/token", {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: pair.verifier,
    redirect_uri: redirect,
    resource,
  });
  if (
    !tokens.access_token ||
    !tokens.refresh_token ||
    tokens.token_type?.toLowerCase() !== "bearer"
  )
    throw new Error("授权服务未返回有效的访问令牌。");
  const auth = await connectToken(origin, tokens.access_token);
  return {
    ...auth,
    clientId,
    resource,
    refreshToken: tokens.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + tokens.expires_in,
  };
}
export async function refreshOAuth(auth: AuthSession) {
  if (!auth.refreshToken || !auth.clientId || !auth.resource) return auth;
  const t = await oauthJSON<TokenReply>(auth.origin, "/oauth/token", {
    grant_type: "refresh_token",
    client_id: auth.clientId,
    refresh_token: auth.refreshToken,
    resource: auth.resource,
  });
  if (!t.access_token || !t.refresh_token)
    throw new Error("刷新授权没有完成，请重新连接。");
  return {
    ...auth,
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + t.expires_in,
  };
}
export async function revokeOAuth(auth: AuthSession) {
  if (!auth.clientId) return false;
  await oauthJSON(auth.origin, "/oauth/revoke", {
    client_id: auth.clientId,
    token: auth.refreshToken || auth.accessToken,
  });
  return true;
}
