import { serviceOrigin } from "../core/capture";

export function permissionPattern(raw: string) {
  const u = new URL(raw);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw new Error("填写没有凭据或查询参数的 API 地址。");
  if (
    u.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
  )
    throw new Error("只有本机 AI 服务可以使用 HTTP。");
  // Chrome match patterns are host-wide and do not express port-level permission.
  // The transport separately pins the exact origin, including its port.
  return u.protocol + "//" + u.hostname + "/*";
}
/** Must be invoked from a button gesture, before any async storage reads. */
export async function allowHost(url: string) {
  if (
    !(await chrome.permissions.request({ origins: [permissionPattern(url)] }))
  )
    throw new Error("没有获得该服务的访问权限；未发送数据。");
}
export function aiAddress(raw: string, system: string) {
  const u = new URL(raw);
  permissionPattern(raw);
  if (u.origin === serviceOrigin(system))
    throw new Error("AI 地址不能指向知识系统。模型 Key 不通过系统代理。");
  return u.href.replace(/\/$/, "");
}
