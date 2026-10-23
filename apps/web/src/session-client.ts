import { canonicalJson, type EditOperation, type EditTransaction, type Precondition, type SessionLook, type TaskReceipt } from "@glintai/session";
import type { SceneScriptProject } from "@glintai/scenescript";

export type SessionView = {
  project: SceneScriptProject; look: SessionLook | null; receipt: TaskReceipt | null;
  status: "opening" | "ready" | "saving" | "conflict" | "error"; message: string; dirty: boolean;
  remote: SceneScriptProject | null;
};
type Reply = { snapshot: { document: SceneScriptProject; revision: number }; look: SessionLook; receipt?: TaskReceipt; conflict?: boolean; error?: string };
type Transport = (url: string, init?: RequestInit) => Promise<Response>;
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Small field edits stay field edits. Reordered arrays require an equality guard. */
export function diffProject(before: SceneScriptProject, after: SceneScriptProject): { operations: EditOperation[]; preconditions: Precondition[] } {
  const operations: EditOperation[] = [], preconditions: Precondition[] = [];
  const walk = (a: unknown, b: unknown, path: string[]) => {
    if (equal(a, b)) return;
    if (a && b && typeof a === "object" && typeof b === "object") {
      if (Array.isArray(a) && Array.isArray(b)) {
        const sameOrder = a.length === b.length && a.every((v, i) => v && typeof v === "object" && "id" in v && (b[i] as { id?: string })?.id === v.id);
        if (sameOrder) { a.forEach((v, i) => walk(v, b[i], [...path, String(i)])); return; }
      } else if (!Array.isArray(a) && !Array.isArray(b)) {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], [...path, key]);
        return;
      }
    }
    preconditions.push(a === undefined ? { kind: "exists", path, expected: false } : { kind: "equals", path, value: a });
    operations.push(b === undefined ? { kind: "delete", path } : { kind: "set", path, value: b });
  };
  walk(json(before), json(after), []); return { operations, preconditions };
}

/** Serializes local intent; never retries an ambiguous write with a new transaction id. */
export class StudioSessionClient {
  private baseline: SceneScriptProject | null = null;
  private draft: SceneScriptProject;
  private look: SessionLook | null = null;
  private receipt: TaskReceipt | null = null;
  private remote: SceneScriptProject | null = null;
  private status: SessionView["status"] = "opening";
  private message = "正在连接共享工程";
  private pending: { action: string; body: Record<string, unknown>; draft: SceneScriptProject } | null = null;
  private sending = false;
  private disposed = false;
  constructor(initial: SceneScriptProject, private readonly changed: (value: SessionView) => void, private readonly transport: Transport = (url, init) => globalThis.fetch(url, init)) { this.draft = json(initial); }
  state(): SessionView { return { project: json(this.draft), look: this.look && json(this.look), receipt: this.receipt && json(this.receipt), status: this.status, message: this.message, dirty: !this.baseline || !equal(this.baseline, this.draft), remote: this.remote && json(this.remote) }; }
  private emit() { if (!this.disposed) this.changed(this.state()); }
  private async request(action: string, body?: Record<string, unknown>): Promise<{ response: Response; value: Reply }> {
    const response = await this.transport(body ? `/api/session/${action}` : `/api/session/${action}?projectId=${encodeURIComponent(this.draft.id)}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: this.draft.id, ...body }) } : undefined);
    return { response, value: await response.json() };
  }
  async connect(): Promise<void> {
    if (this.disposed || this.sending) return;
    this.sending = true;
    const initial = json(this.draft);
    try {
      const { response, value } = await this.request("open", { project: initial });
      if (!response.ok) throw new Error(value.error ?? "共享工程连接失败");
      if (!value.snapshot?.document || !value.look) throw new Error("共享工程响应不完整");
      if (this.disposed) return;
      this.baseline = value.snapshot.document; this.look = value.look;
      if (value.conflict) { this.remote = value.snapshot.document; this.status = "conflict"; this.message = "本地草稿与共享工程不同，请选择接续版本"; }
      else { this.status = "ready"; this.message = `共享工程 · r${value.look.revision}`; }
    } catch (error) { this.status = "error"; this.message = error instanceof Error ? error.message : "连接失败"; }
    finally { this.sending = false; this.emit(); }
    if (this.status === "ready") await this.flush();
  }
  update(project: SceneScriptProject): void {
    if (project.id !== this.draft.id) throw new Error("Cannot switch project identity inside a session");
    this.draft = json(project); this.emit(); void this.flush();
  }
  private async flush(): Promise<void> {
    if (this.disposed || this.sending || !this.baseline || !this.look || this.status === "conflict" || this.status === "error" || equal(this.baseline, this.draft)) return;
    const patch = diffProject(this.baseline, this.draft);
    const transaction: EditTransaction = { id: `studio-${crypto.randomUUID()}`, projectId: this.draft.id, baseRevision: this.look.revision, actor: "user", scope: {}, ...patch, intent: "Studio 编辑" };
    this.pending = { action: "apply", body: { transaction }, draft: json(this.draft) };
    await this.sendPending();
  }
  private async sendPending(): Promise<void> {
    if (this.disposed || this.sending || !this.pending) return;
    this.sending = true; this.status = "saving"; this.message = "正在保存共享工程"; this.emit();
    const pending = this.pending;
    try {
      const { response, value } = await this.request(pending.action, pending.body);
      if (this.disposed) return;
      if (!response.ok) {
        if (response.status === 409 && value.snapshot) {
          this.remote = value.snapshot.document; this.look = value.look; this.status = "conflict"; this.message = value.receipt?.reason ?? "共享工程已被其他入口修改"; this.receipt = value.receipt ?? null;
          return;
        }
        throw new Error(value.receipt?.reason ?? value.error ?? "共享工程保存失败");
      }
      if (!value.look || !value.snapshot?.document || !value.receipt || !["saved", "verified"].includes(value.receipt.stage)) throw new Error("保存回执不完整，请恢复查询");
      if (value.receipt.revision !== value.look.revision && !equal(this.draft, pending.draft)) {
        this.remote = value.snapshot.document; this.look = value.look; this.receipt = value.receipt; this.status = "conflict"; this.message = "原提交已保存，但其他入口随后修改了工程；请审阅保留的本地草稿"; return;
      }
      // While a request is in flight, keystrokes remain in draft and become the next patch.
      if (equal(this.draft, pending.draft)) this.draft = value.snapshot.document;
      this.baseline = value.snapshot.document; this.look = value.look; this.receipt = value.receipt;
      this.pending = null; this.remote = null; this.status = "ready"; this.message = `已保存并回读 · r${value.look.revision}`;
    } catch (error) { if (!this.disposed) { this.status = "error"; this.message = error instanceof Error ? error.message : "保存回执未确认"; } }
    finally { this.sending = false; this.emit(); }
    if (this.status === "ready") await this.flush();
  }
  async retry(): Promise<void> { if (this.pending) await this.sendPending(); else await this.connect(); }
  async poll(): Promise<void> {
    if (this.disposed || this.sending || !this.look || this.status !== "ready") return;
    const revision = this.look.revision;
    try {
      const { response, value } = await this.request("snapshot");
      if (!response.ok || !value.look || !value.snapshot?.document || this.disposed || this.sending || this.look?.revision !== revision) return;
      if (value.look.revision !== revision) {
        if (this.state().dirty) { this.remote = value.snapshot.document; this.status = "conflict"; this.message = "其他入口已修改工程，本地草稿已保留"; }
        else { this.baseline = value.snapshot.document; this.draft = value.snapshot.document; this.message = `已同步其他入口 · r${value.look.revision}`; }
      }
      this.look = value.look; this.emit();
    } catch { /* A read failure does not imply that a previous write failed. */ }
  }
  async reload(): Promise<void> {
    if (this.sending) return;
    try {
      const { response, value } = await this.request("snapshot");
      if (!response.ok || !value.snapshot?.document) throw new Error(value.error ?? "读取共享版本失败");
      if (this.disposed) return;
      this.draft = value.snapshot.document; this.baseline = value.snapshot.document; this.look = value.look; this.pending = null; this.remote = null; this.status = "ready"; this.message = `已接续共享版本 · r${value.look.revision}`; this.emit();
    } catch (error) { this.status = "error"; this.message = error instanceof Error ? error.message : "读取失败"; this.emit(); }
  }
  async select(handles: string[]): Promise<void> {
    if (!this.look || this.disposed) return;
    try {
      const { response, value } = await this.request("select", { handles });
      if (!response.ok || this.disposed || !this.look || value.look.revision !== this.look.revision) return;
      this.look = value.look; this.emit();
    } catch { /* Selection can be retried without changing document revision. */ }
  }
  async history(action: "undo" | "redo"): Promise<void> {
    if (this.sending || this.state().dirty || this.status !== "ready" || !this.look) return;
    this.pending = { action, body: { transactionId: `studio-${crypto.randomUUID()}`, baseRevision: this.look.revision, actor: "user" }, draft: json(this.draft) };
    await this.sendPending();
  }
  dispose(): void { this.disposed = true; }
}
