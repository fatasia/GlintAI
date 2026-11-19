import { appFetch as fetch } from "./app-url";
import { canonicalJson, type EditOperation, type EditTransaction, type Precondition, type SessionLook, type TaskReceipt } from "@glintai/session";
import type { SceneScriptProject } from "@glintai/scenescript";

export type SessionDocument = { id: string; assets?: SceneScriptProject["assets"]; frozen?: boolean };
export type DocumentSessionTransport<T extends SessionDocument> = (action: string, body: Record<string, unknown> | undefined, submittedDraft: T) => Promise<Response>;
export type SessionView<T extends SessionDocument = SceneScriptProject> = {
  project: T; look: SessionLook | null; receipt: TaskReceipt | null;
  status: "opening" | "ready" | "saving" | "conflict" | "error"; message: string; dirty: boolean;
  remote: T | null; untrustedImport: boolean;
};
type Reply<T extends SessionDocument> = { snapshot: { document: T; revision: number }; look: SessionLook; receipt?: TaskReceipt; conflict?: boolean; error?: string; code?: string };
type Transport = (url: string, init?: RequestInit) => Promise<Response>;
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Small field edits stay field edits. Reordered arrays require an equality guard. */
export function diffProject(before: SessionDocument, after: SessionDocument): { operations: EditOperation[]; preconditions: Precondition[] } {
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
export class StudioSessionClient<T extends SessionDocument = SceneScriptProject> {
  private baseline: T | null = null;
  private draft: T;
  private look: SessionLook | null = null;
  private receipt: TaskReceipt | null = null;
  private remote: T | null = null;
  private untrustedImport = false;
  private status: SessionView["status"] = "opening";
  private message = "正在连接共享工程";
  private pending: { action: string; body: Record<string, unknown>; draft: T } | null = null;
  private sending = false;
  private readGeneration = 0;
  private disposed = false;
  constructor(initial: T, private readonly changed: (value: SessionView<T>) => void, private readonly transport: Transport = fetch, private readonly documentTransport?: DocumentSessionTransport<T>) { this.draft = json(initial); }
  state(): SessionView<T> { return { project: json(this.draft), look: this.look && json(this.look), receipt: this.receipt && json(this.receipt), status: this.status, message: this.message, dirty: !this.baseline || !equal(this.baseline, this.draft), remote: this.remote && json(this.remote), untrustedImport: this.untrustedImport }; }
  private emit() { if (!this.disposed) this.changed(this.state()); }
  private async request(action: string, body?: Record<string, unknown>): Promise<{ response: Response; value: Reply<T> }> {
    const response = this.documentTransport ? await this.documentTransport(action, body, json(this.pending?.draft ?? this.draft)) : await this.transport(body ? `/api/session/${action}` : `/api/session/${action}?projectId=${encodeURIComponent(this.draft.id)}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: this.draft.id, ...body }) } : undefined);
    return { response, value: await response.json() };
  }
  async connect(): Promise<void> {
    if (this.disposed || this.sending) return;
    this.sending = true;
    const initial = json(this.draft);
    try {
      const { response, value } = await this.request("open", { project: initial });
      if (!response.ok) {
        this.untrustedImport = value.code === "untrusted-import";
        throw new Error(this.untrustedImport ? "导入工程包含无法验证的旧批准记录。可保留原件，并创建未批准的工程副本重新审阅。" : value.error ?? "共享工程连接失败");
      }
      this.untrustedImport = false;
      if (!value.snapshot?.document || !value.look) throw new Error("共享工程响应不完整");
      if (this.disposed) return;
      this.baseline = value.snapshot.document; this.look = value.look;
      if (value.conflict) { this.remote = value.snapshot.document; this.status = "conflict"; this.message = "本地草稿与共享工程不同，请选择接续版本"; }
      else { this.status = "ready"; this.message = `共享工程 · r${value.look.revision}`; }
    } catch (error) { this.status = "error"; this.message = error instanceof Error ? error.message : "连接失败"; }
    finally { this.sending = false; this.emit(); }
    if (this.status === "ready") await this.flush();
  }
  update(project: T, meta?: { actor?: "user" | "product-agent"; intent?: string }): void {
    if (project.id !== this.draft.id) throw new Error("Cannot switch project identity inside a session");
    // The pending label is replaced on every update, so a plain (manual) edit
    // can never inherit the previous agent labeling.
    this.meta = meta?.actor === "product-agent" ? { actor: "product-agent", intent: meta.intent ?? "AI 助手修改" } : undefined;
    this.draft = json(project); this.emit(); void this.flush();
  }
  private meta?: { actor: "product-agent"; intent: string };
  private async flush(): Promise<void> {
    if (this.disposed || this.sending || !this.baseline || !this.look || this.status === "conflict" || this.status === "error" || equal(this.baseline, this.draft)) return;
    const patch = diffProject(this.baseline, this.draft);
    const meta = this.meta; this.meta = undefined;
    const transaction: EditTransaction = { id: `studio-${crypto.randomUUID()}`, projectId: this.draft.id, baseRevision: this.look.revision, actor: meta?.actor ?? "user", scope: {}, ...patch, intent: meta?.intent ?? "Studio 编辑" };
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
      // Server-side operations may change fields outside the pending draft.
      // Concurrent typing must not reapply the old values over their result.
      if (["undo", "redo", "approve-character", "approve-product", "adopt-reference-candidate"].includes(pending.action) && !equal(this.draft, pending.draft)) {
        this.baseline = value.snapshot.document; this.remote = value.snapshot.document; this.look = value.look; this.receipt = value.receipt; this.pending = null;
        this.status = "conflict"; this.message = "共享操作已保存，但本地草稿同时变化；请保留副本并审阅共享版本。"; return;
      }
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
    const revision = this.look.revision, generation = this.readGeneration;
    try {
      const { response, value } = await this.request("snapshot");
      if (!response.ok || !value.look || !value.snapshot?.document || this.disposed || this.sending || generation !== this.readGeneration || this.look?.revision !== revision || this.status !== "ready") return;
      if (value.look.revision !== revision) {
        if (this.state().dirty) { this.remote = value.snapshot.document; this.status = "conflict"; this.message = "其他入口已修改工程，本地草稿已保留"; }
        else { this.baseline = value.snapshot.document; this.draft = value.snapshot.document; this.message = `已同步其他入口 · r${value.look.revision}`; }
      }
      this.look = value.look; this.emit();
    } catch { /* A read failure does not imply that a previous write failed. */ }
  }
  async reload(): Promise<void> {
    if (this.disposed || this.sending) return;
    this.sending = true; this.readGeneration++;
    const savedDraft = json(this.draft);
    try {
      const { response, value } = await this.request("snapshot");
      if (!response.ok || !value.snapshot?.document || !value.look) throw new Error(value.error ?? "读取共享版本失败");
      if (this.disposed) return;
      if (!equal(this.draft, savedDraft)) {
        this.remote = value.snapshot.document; this.look = value.look;
        this.status = "conflict"; this.message = "读取共享版本期间本地草稿发生变化；尚未接续共享版本，请再次备份并审阅。"; this.emit(); return;
      }
      this.draft = value.snapshot.document; this.baseline = value.snapshot.document; this.look = value.look; this.pending = null; this.remote = null; this.status = "ready"; this.message = `已接续共享版本 · r${value.look.revision}`; this.emit();
    } catch (error) { if (!this.disposed) { this.status = "error"; this.message = error instanceof Error ? error.message : "读取失败"; this.emit(); } }
    finally { this.sending = false; }
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
  /** Server pins image bytes and commits approval under the existing revision lock. */
  async approveCharacter(assetId: string): Promise<boolean> { return this.approveIdentity(assetId, "character"); }
  async approveProduct(assetId: string): Promise<boolean> { return this.approveIdentity(assetId, "product"); }
  private async approveIdentity(assetId: string, kind: "character" | "product"): Promise<boolean> {
    if (this.disposed || this.sending || !this.baseline || !this.look || this.status !== "ready" || !equal(this.baseline, this.draft)) return false;
    const transactionId = `studio-${kind}-${crypto.randomUUID()}`;
    this.pending = { action: `approve-${kind}`, body: { transactionId, baseRevision: this.look.revision, assetId }, draft: json(this.draft) };
    await this.sendPending();
    return this.status === "ready" && this.receipt?.transactionId === transactionId && Boolean(this.draft.assets?.find(asset => asset.id === assetId && asset.kind === kind)?.approval?.refSha256);
  }
  /** Apply reference-bound candidates only through the server's locked validation. */
  async adoptReferenceCandidate(taskId: string, mode: "replace" | "insert"): Promise<boolean> {
    if (this.disposed || this.sending || !this.baseline || !this.look || this.status !== "ready" || !equal(this.baseline, this.draft)) return false;
    const transactionId = `studio-candidate-${crypto.randomUUID()}`;
    this.pending = { action: "adopt-reference-candidate", body: { transactionId, baseRevision: this.look.revision, taskId, mode }, draft: json(this.draft) };
    await this.sendPending();
    return this.status === "ready" && this.receipt?.transactionId === transactionId && ["saved", "verified"].includes(this.receipt.stage);
  }
  /** Approval freeze (TEAM-09): owner-only single-operation freeze/unfreeze. Local edits must be settled first, or the server would refuse the bundled diff with 409. */
  async setFrozen(frozen: boolean): Promise<void> {
    if (this.disposed || this.sending || !this.baseline || !this.look || this.status !== "ready") return;
    if (!equal(this.baseline, this.draft)) { this.message = "本地修改未同步；请先保存或接续共享版本，再切换批准冻结"; this.emit(); return; }
    const transaction: EditTransaction = { id: `studio-frozen-${crypto.randomUUID()}`, projectId: this.draft.id, baseRevision: this.look.revision, actor: "user", scope: {}, operations: [{ kind: "set", path: ["frozen"], value: frozen }], intent: frozen ? "批准冻结" : "批准解冻" };
    this.draft = json({ ...this.draft, frozen });
    this.pending = { action: "apply", body: { transaction }, draft: json(this.draft) };
    await this.sendPending();
  }
  dispose(): void { this.disposed = true; }
}
