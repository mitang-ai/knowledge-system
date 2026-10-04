import { serviceOrigin } from "./capture";
import type { Capabilities, WritePayload, WriteResult } from "../types";

export class SystemError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = "network_error",
  ) {
    super(message);
    this.name = "SystemError";
  }
}
export async function systemRequest<T>(
  origin: string,
  path: string,
  token: string,
  body?: unknown,
  idempotencyKey?: string,
  fetcher = fetch,
): Promise<T> {
  origin = serviceOrigin(origin);
  if (!/^\/api\/v1\/[a-z0-9/_-]+$/.test(path))
    throw new SystemError("不允许请求这个系统接口。");
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: "Bearer " + token,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let r: Response;
  try {
    r = await fetcher(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new SystemError(
      "没有收到系统的确认。记录仍在本机，重试不会换提交标识。",
    );
  }
  let value: Record<string, unknown>;
  try {
    value = await r.json();
  } catch {
    throw new SystemError("系统响应格式不正确；不能确认是否已收录。", r.status);
  }
  if (!r.ok) {
    const code =
      typeof value.error === "object" && value.error
        ? String((value.error as Record<string, unknown>).code)
        : "request_failed";
    const messages: Record<number, string> = {
      401: "授权已过期，请重新连接。待同步记录仍保留。",
      403: "当前授权不允许此操作，请在系统里检查范围与直接写入权限。",
      409: "提交标识或修订冲突，请核对原记录，不要重复新建。",
      429: "请求或每日写入额度已到上限，稍后再试。",
    };
    throw new SystemError(
      messages[r.status] || "系统未接收这份记录（HTTP " + r.status + "）。",
      r.status,
      code,
    );
  }
  if (value.schema_version !== "sediment.api.v1")
    throw new SystemError("这个服务不支持沉淀 v1 接口。");
  return value as T;
}
/** Browser-independent SDK transport; usable from Node or another local program. */
export class CaptureClient {
  constructor(
    readonly origin: string,
    private readonly token: string,
    private readonly fetcher = fetch,
  ) {
    serviceOrigin(origin);
  }
  capabilities() {
    return systemRequest<Capabilities>(
      this.origin,
      "/api/v1/capabilities",
      this.token,
      undefined,
      undefined,
      this.fetcher,
    );
  }
  write(payload: WritePayload, idempotencyKey: string, proposal = false) {
    return systemRequest<WriteResult>(
      this.origin,
      proposal ? "/api/v1/proposals" : "/api/v1/write",
      this.token,
      payload,
      idempotencyKey,
      this.fetcher,
    );
  }
}
