import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { assertJson, canonicalJson, ProjectSession, type EditTransaction, type SessionActor, type SessionState, type TaskReceipt } from "./index";

export const DEFAULT_SESSION_DIRECTORY = fileURLToPath(new URL("../../../apps/studio/out/.sessions/", import.meta.url));
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
type Projection = { file: string; digest: string; pending?: boolean };
interface StoredState extends SessionState { projection?: Projection }
type Envelope = { version: 1; checksum: string; state: StoredState };
export class SessionStoreError extends Error {
  constructor(readonly code: "not-found" | "busy" | "corrupt" | "external-change" | "project-conflict", message: string) { super(message); this.name = "SessionStoreError"; }
}
/** One authoritative JSON commit, guarded by an OS-exclusive per-project file lock.
 * Project files are recoverable projections; the journal is always committed first.
 */
export class FileSessionStore {
  readonly directory: string;
  constructor(directory = process.env.GLINT_SESSION_DIR ?? DEFAULT_SESSION_DIRECTORY, private readonly validate?: (document: Record<string, unknown>) => void, private readonly afterCommit?: () => void) {
    this.directory = path.resolve(directory); fs.mkdirSync(this.directory, { recursive: true });
  }
  private file(id: string): string {
    if (typeof id !== "string" || !id.trim() || id.length > 200) throw new Error("Invalid project id");
    return path.join(this.directory, `${sha(id)}.json`);
  }
  private lock<T>(id: string, action: () => T): T {
    const lock = `${this.file(id)}.lock`;
    let fd: number;
    try { fd = fs.openSync(lock, "wx"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // No force-unlock by age: a slow writer is not a crashed writer.
      let owner: { pid?: number } = {};
      try { owner = JSON.parse(fs.readFileSync(lock, "utf8")); } catch { /* Incomplete lock: leave it intact. */ }
      let dead = false;
      if (Number.isInteger(owner.pid) && owner.pid! > 0) {
        try { process.kill(owner.pid!, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === "ESRCH"; }
      }
      if (!dead) throw new SessionStoreError("busy", "Project is being edited by another process; retry the same transaction id");
      // Atomic rename elects one recovery process; it keeps ownership while replacing the dead lock.
      const abandoned = `${lock}.abandoned`;
      let recovery: number;
      try { recovery = fs.openSync(abandoned, "wx"); } catch { throw new SessionStoreError("busy", "Project lock recovery is in progress"); }
      try {
        const current = JSON.parse(fs.readFileSync(lock, "utf8"));
        if (current.pid !== owner.pid) throw new SessionStoreError("busy", "Project writer changed");
        fs.unlinkSync(lock); fd = fs.openSync(lock, "wx");
      } finally { fs.closeSync(recovery); fs.unlinkSync(abandoned); }
    }
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd); return action(); }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  private atomic(file: string, value: unknown): void {
    const temp = `${file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(temp, "wx"); fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
      // Directory fsync is supported on Unix; Windows does not expose it consistently.
      if (process.platform !== "win32") { const dir = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
    } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  private write(state: StoredState): void { this.atomic(this.file(state.projectId), { version: 1, checksum: sha(canonicalJson(state)), state }); }
  private read(id: string): StoredState {
    const file = this.file(id);
    if (!fs.existsSync(file)) throw new SessionStoreError("not-found", "Session not found");
    let envelope: Envelope;
    try {
      envelope = JSON.parse(fs.readFileSync(file, "utf8")); assertJson(envelope);
      if (envelope.version !== 1 || envelope.state.projectId !== id || sha(canonicalJson(envelope.state)) !== envelope.checksum) throw new Error("checksum");
      const state = envelope.state;
      if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.history) || state.history.length !== state.revision || state.history.some((e, i) => e.revision !== i + 1)) throw new Error("history");
      this.session(state); return state;
    } catch { throw new SessionStoreError("corrupt", "Session checksum, history or document validation failed"); }
  }
  private session(state: StoredState): ProjectSession {
    if (state.document.id !== undefined && state.document.id !== state.projectId) throw new Error("Project document id does not match session id");
    return new ProjectSession(state.projectId, state.document, state.revision, state.history, state.selection, this.validate);
  }
  private projectionDigest(file: string): string {
    try { const document = JSON.parse(fs.readFileSync(file, "utf8")); assertJson(document); return sha(canonicalJson(document)); }
    catch { throw new SessionStoreError("external-change", "The linked project file was removed or is no longer valid JSON"); }
  }
  private recoverProjection(state: StoredState): void {
    const projection = state.projection;
    if (!projection) return;
    const actual = this.projectionDigest(projection.file), desired = sha(canonicalJson(state.document));
    if (actual !== projection.digest && !(projection.pending && actual === desired)) throw new SessionStoreError("external-change", "The linked project file changed outside Glint. Import it under a new project id or restore the last exported revision");
    if (projection.pending) {
      if (actual !== desired) this.atomic(projection.file, state.document);
      state.projection = { file: projection.file, digest: desired }; this.write(state);
    }
  }
  private result(state: StoredState) { const session = this.session(state); return { snapshot: session.snapshot(), look: session.look() }; }
  open(projectId: string, document: Record<string, unknown>, projectFile?: string) {
    return this.lock(projectId, () => {
      assertJson(document);
      if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("A project document is required");
      let state: StoredState;
      if (fs.existsSync(this.file(projectId))) {
        state = this.read(projectId); this.recoverProjection(state);
        const conflict = canonicalJson(state.document) !== canonicalJson(document);
        // Opening never overwrites a newer durable revision with a browser/local draft.
        if (conflict) return { ...this.result(state), conflict: true };
      } else {
        state = { projectId, document, revision: 0, history: [], selection: [] }; this.session(state);
      }
      if (projectFile) {
        const file = fs.realpathSync(projectFile);
        if (state.projection && state.projection.file !== file) throw new SessionStoreError("project-conflict", "This session is already linked to a different project file");
        if (this.projectionDigest(file) !== sha(canonicalJson(document))) throw new SessionStoreError("external-change", "Project file changed while opening");
        state.projection = { file, digest: sha(canonicalJson(document)) };
      }
      this.write(state); return { ...this.result(state), conflict: false };
    });
  }
  snapshot(projectId: string) { return this.lock(projectId, () => { const state = this.read(projectId); this.recoverProjection(state); return this.result(state); }); }
  list() {
    return fs.readdirSync(this.directory).filter(f => /^[a-f0-9]{64}\.json$/.test(f)).flatMap(file => {
      try { const envelope = JSON.parse(fs.readFileSync(path.join(this.directory, file), "utf8")) as Envelope; const state = this.read(envelope.state.projectId); return [{ projectId: state.projectId, title: state.document.title, revision: state.revision }]; }
      catch { return []; }
    });
  }
  inspect(projectId: string, jsonPath: string[]) { const { snapshot } = this.snapshot(projectId); return { revision: snapshot.revision, ...new ProjectSession(projectId, snapshot.document).inspect(jsonPath) }; }
  select(projectId: string, handles: string[]) {
    return this.lock(projectId, () => { const state = this.read(projectId); this.recoverProjection(state); const session = this.session(state); session.select(handles); state.selection = session.look().selection; this.write(state); return this.result(state); });
  }
  apply(projectId: string, transaction: EditTransaction) { return this.mutate(projectId, session => session.submit(transaction)); }
  /** Evaluate semantic edits under the same lock/CAS as persistence. Retries never run the edit twice. */
  applyTransform(
    projectId: string,
    request: Omit<EditTransaction, "projectId" | "operations">,
    transform: (document: Record<string, unknown>) => EditTransaction["operations"],
  ) {
    return this.mutate(projectId, session => {
      const prior = session.exportState().history.find(entry => entry.transaction.id === request.id);
      if (prior) return session.submit({ ...prior.transaction, ...request, projectId });
      if (session.snapshot().revision !== request.baseRevision) {
        return session.submit({ ...request, projectId, operations: [] });
      }
      const operations = transform(session.snapshot().document);
      return session.submit({ ...request, projectId, operations });
    });
  }
  historyEdit(projectId: string, action: "undo" | "redo", id: string, baseRevision: number, actor: SessionActor) {
    return this.mutate(projectId, session => session.historyEdit(action, id, baseRevision, actor));
  }
  private mutate(projectId: string, edit: (session: ProjectSession) => TaskReceipt) {
    return this.lock(projectId, () => {
      const state = this.read(projectId); this.recoverProjection(state);
      const session = this.session(state), receipt = edit(session);
      if (receipt.stage === "refused") return { ...this.result(state), receipt };
      const next: StoredState = { ...session.exportState(), ...(state.projection ? { projection: { ...state.projection, pending: true } } : {}) };
      if (next.revision !== state.revision) next.history.at(-1)!.documentSha256 = sha(canonicalJson(next.document));
      this.write(next); this.afterCommit?.(); this.recoverProjection(next);
      // New file handle, checksum and document readback, after the atomic rename.
      const readback = this.read(projectId);
      return { ...this.result(readback), receipt: this.verifyState(readback, receipt.transactionId) };
    });
  }
  private verifyState(state: StoredState, transactionId: string): TaskReceipt {
    const session = this.session(state), receipt = session.verify(transactionId);
    if (receipt.stage === "refused") return receipt;
    if (receipt.revision !== state.revision) return { ...receipt, stage: "saved", reason: "Committed revision exists; a later revision is now current" };
    const documentSha256 = state.history.find(e => e.transaction.id === transactionId)?.documentSha256;
    if (!documentSha256 || documentSha256 !== sha(canonicalJson(state.document)) || receipt.digest !== session.snapshot().digest) return { ...receipt, stage: "failed", reason: "Committed document readback does not match the transaction" };
    const { reason: _, ...proof } = receipt;
    return { ...proof, stage: "verified", documentSha256, verification: "document-readback" };
  }
  verify(projectId: string, transactionId: string) {
    return this.lock(projectId, () => { const state = this.read(projectId); this.recoverProjection(state); return this.verifyState(this.read(projectId), transactionId); });
  }
}
