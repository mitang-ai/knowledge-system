export async function message<T>(
  type: string,
  fields: Record<string, unknown> = {},
): Promise<T> {
  const reply = await chrome.runtime.sendMessage({ type, ...fields });
  if (!reply?.ok)
    throw new Error(
      reply?.error || "插件后台没有完成请求。草稿仍可留在当前页面。",
    );
  return reply.data as T;
}
