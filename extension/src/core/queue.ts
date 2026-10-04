import { SystemError } from "./system-client";
import type {
  AuthSession,
  CaptureEnvelope,
  QueueEntry,
  WritePayload,
  WriteResult,
} from "../types";
import { ownerKey } from "../types";

export interface QueueStore {
  get(): Promise<QueueEntry[]>;
  set(entries: QueueEntry[]): Promise<void>;
}
export class CaptureQueue {
  private mutation: Promise<unknown> = Promise.resolve();
  private running: Promise<void> | null = null;
  constructor(
    private readonly store: QueueStore,
    private readonly send: (
      e: QueueEntry,
      auth: AuthSession,
    ) => Promise<WriteResult>,
    private readonly auth: () => Promise<AuthSession | null>,
    private readonly now = Date.now,
  ) {}
  private change<T>(fn: (rows: QueueEntry[]) => T | Promise<T>): Promise<T> {
    const next = this.mutation.then(async () => {
      const rows = await this.store.get();
      const result = await fn(rows);
      await this.store.set(rows);
      return result;
    });
    this.mutation = next.catch(() => {});
    return next;
  }
  async enqueue(
    capture: CaptureEnvelope,
    payload: WritePayload,
    auth: AuthSession,
  ): Promise<QueueEntry> {
    const mode = auth.scopes.includes("knowledge:write")
      ? "write"
      : auth.scopes.includes("proposals:create")
        ? "proposal"
        : null;
    if (!mode)
      throw new Error(
        "这份授权只有读取权限。请重新授权直接写入或提交待采纳建议。",
      );
    if (!auth.spaces.includes(payload.space_id))
      throw new Error("没有获得这个空间的访问权限。");
    return this.change((rows) => {
      const prior = rows.find((e) => e.id === capture.id);
      if (prior) {
        if (
          prior.ownerKey !== ownerKey(auth) ||
          prior.grantId !== auth.grantId ||
          JSON.stringify(prior.payload) !== JSON.stringify(payload)
        )
          throw new Error(
            "这个提交已有不同内容或授权。请先核对旧提交，再另存新稿，不能覆盖重试。",
          );
        return prior;
      }
      if (
        rows.filter((r) => !["saved", "proposal"].includes(r.status)).length >=
        50
      )
        throw new Error("待同步记录已达 50 条，请先处理队列；新稿仍可导出。");
      const row: QueueEntry = {
        id: capture.id,
        ownerKey: ownerKey(auth),
        grantId: auth.grantId,
        origin: auth.origin,
        capture: structuredClone(capture),
        payload: structuredClone(payload),
        mode,
        status: "pending",
        attempts: 0,
        nextAt: this.now(),
        updatedAt: new Date(this.now()).toISOString(),
      };
      rows.push(row);
      return structuredClone(row);
    });
  }
  async recover() {
    await this.change((rows) =>
      rows.forEach((r) => {
        if (r.status === "sending") {
          r.status = "pending";
          r.error = "上次发送未收到确认，将使用原提交标识核对。";
        }
      }),
    );
  }
  async retry(id: string) {
    await this.change((rows) => {
      const row = rows.find((r) => r.id === id);
      if (!row || row.status !== "failed") return;
      row.status = "pending";
      row.nextAt = this.now();
      row.attempts = 0;
    });
    await this.drain();
  }
  async remove(id: string) {
    await this.change((rows) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) {
        if (rows[i].status === "sending")
          throw new Error("正在等待系统确认，请稍后再移出。");
        rows.splice(i, 1);
      }
    });
  }
  drain() {
    if (this.running) return this.running;
    this.running = this.perform().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async perform() {
    for (let count = 0; count < 3; count++) {
      const auth = await this.auth();
      if (!auth) return;
      const entry = await this.change((rows) => {
        const e = rows.find(
          (r) =>
            r.status === "pending" &&
            r.nextAt <= this.now() &&
            r.ownerKey === ownerKey(auth) &&
            r.grantId === auth.grantId,
        );
        if (!e) return null;
        e.status = "sending";
        e.attempts++;
        e.updatedAt = new Date(this.now()).toISOString();
        return structuredClone(e);
      });
      if (!entry) return;
      try {
        const result = await this.send(entry, auth);
        if (
          entry.mode === "write"
            ? !result.item_id
            : !(result.id || result.proposal_id)
        )
          throw new SystemError("系统未返回记录标识，暂不能确认收录结果。");
        await this.change((rows) => {
          const e = rows.find((r) => r.id === entry.id);
          if (e) {
            e.status = entry.mode === "write" ? "saved" : "proposal";
            e.result = result;
            e.error = undefined;
            e.updatedAt = new Date(this.now()).toISOString();
          }
        });
      } catch (error) {
        const permanent =
          error instanceof SystemError &&
          [400, 401, 403, 404, 409, 413].includes(error.status);
        await this.change((rows) => {
          const e = rows.find((r) => r.id === entry.id);
          if (e) {
            e.error =
              error instanceof SystemError
                ? error.message
                : "发送未完成，记录仍在本机。";
            e.status = permanent || e.attempts >= 5 ? "failed" : "pending";
            e.nextAt =
              this.now() +
              Math.min(60 * 60 * 1000, 60000 * 2 ** (e.attempts - 1));
            e.updatedAt = new Date(this.now()).toISOString();
          }
        });
        // No tight retry loops; a single failed request pauses this drain.
        return;
      }
    }
  }
}
