import { refreshOAuth } from "../core/oauth";
import { systemRequest, SystemError } from "../core/system-client";
import { getAuth, putAuth } from "./storage";
import type { AuthSession } from "../types";

let refresh: Promise<AuthSession> | null = null;
async function rotate(auth: AuthSession) {
  if (!refresh)
    refresh = refreshOAuth(auth)
      .then(async (next) => {
        const current = await getAuth();
        if (
          current?.grantId !== auth.grantId ||
          current?.origin !== auth.origin ||
          current?.subject !== auth.subject
        )
          throw new SystemError("授权已切换，停止原请求。", 401);
        await putAuth(next);
        return next;
      })
      .catch(async (error) => {
        const current = await getAuth();
        if (
          error instanceof SystemError &&
          [400, 401, 403].includes(error.status) &&
          current?.grantId === auth.grantId &&
          current?.origin === auth.origin &&
          current?.subject === auth.subject
        )
          await putAuth(null);
        throw error;
      })
      .finally(() => {
        refresh = null;
      });
  return refresh;
}
export async function authorizedRequest<T>(
  path: string,
  body?: unknown,
  id?: string,
  expected?: AuthSession,
): Promise<T> {
  let auth = await getAuth();
  if (!auth) throw new SystemError("先连接你的知识空间；草稿不会丢弃。", 401);
  if (
    expected &&
    (auth.origin !== expected.origin ||
      auth.subject !== expected.subject ||
      auth.grantId !== expected.grantId)
  )
    throw new SystemError("当前授权与这条待同步记录不同，已停止发送。", 403);
  if (
    auth.refreshToken &&
    auth.expiresAt &&
    auth.expiresAt <= Date.now() / 1000 + 30
  )
    auth = await rotate(auth);
  try {
    return await systemRequest<T>(
      auth.origin,
      path,
      auth.accessToken,
      body,
      id,
    );
  } catch (error) {
    if (
      error instanceof SystemError &&
      error.status === 401 &&
      auth.refreshToken
    ) {
      auth = await rotate(auth);
      return systemRequest<T>(auth.origin, path, auth.accessToken, body, id);
    }
    throw error;
  }
}
