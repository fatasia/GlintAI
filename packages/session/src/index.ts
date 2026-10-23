/** Pure session domain. Persistence and durable receipts live in the ./node adapter. */
export type SessionActor = "user" | "product-agent" | "skill" | "cli";
export type ReceiptStage = "refused" | "dispatched" | "saved" | "verified" | "failed";
export type JsonPath = string[];
export type EditOperation =
  | { kind: "set"; path: JsonPath; value: unknown }
  | { kind: "delete"; path: JsonPath }
  | { kind: "insert"; path: JsonPath; index: number; value: unknown }
  | { kind: "move"; path: JsonPath; from: number; to: number };
export type Precondition = { kind: "exists"; path: JsonPath; expected: boolean } | { kind: "equals"; path: JsonPath; value: unknown };
export interface EditTransaction {
  id: string; projectId: string; baseRevision: number; actor: SessionActor;
  scope: { handles?: string[]; timeRange?: { start: string; end: string } };
  operations: EditOperation[]; preconditions?: Precondition[]; intent: string;
}
export interface TaskReceipt {
  transactionId: string; stage: ReceiptStage; projectId: string; baseRevision: number;
  revision?: number; changed: boolean; affectedPaths: JsonPath[]; affectedHandles: string[];
  digest?: string; reason?: string; documentSha256?: string; verification?: "document-readback";
}
export interface SessionSnapshot<T extends object = Record<string, unknown>> { projectId: string; revision: number; document: T; digest: string }
export interface SessionHistoryEntry {
  revision: number; transaction: EditTransaction; inverse: EditOperation[]; digest: string;
  action?: "edit" | "undo" | "redo"; target?: string; changed?: boolean; documentSha256?: string;
}
export interface SessionLook { projectId: string; revision: number; digest: string; selection: string[]; undoDepth: number; redoDepth: number }
export interface SessionState<T extends object = Record<string, unknown>> {
  projectId: string; revision: number; document: T; history: SessionHistoryEntry[]; selection?: string[];
}
export class SessionError extends Error {
  constructor(readonly code: "revision-conflict" | "precondition-failed" | "invalid-operation" | "unknown-transaction", message: string) { super(message); this.name = "SessionError"; }
}
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function invalid(message: string): never { throw new SessionError("invalid-operation", message); }
export function assertJson(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 80) invalid("JSON nesting exceeds 80 levels");
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || ancestors.has(value)) invalid("Expected finite, acyclic JSON values");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid("Expected a plain JSON object");
  ancestors.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) invalid("Reserved JSON key");
    assertJson(child, ancestors, depth + 1);
  }
  if (Array.isArray(value) && Object.keys(value).length !== value.length) invalid("Sparse arrays are not JSON documents");
  ancestors.delete(value);
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
// A UI change token, NOT a cryptographic persistence proof. The node adapter uses SHA-256.
function digest(value: unknown): string {
  let hash = 2166136261;
  for (const char of canonicalJson(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function checkPath(path: unknown, allowRoot = false): asserts path is JsonPath {
  if (!Array.isArray(path) || path.length > 80 || (!allowRoot && !path.length) || path.some(p => typeof p !== "string" || !p || forbidden.has(p))) invalid("Invalid edit path");
}
function arrayIndex(segment: string, length: number): number {
  if (!/^(0|[1-9]\d*)$/.test(segment)) invalid("Invalid array index");
  const index = Number(segment);
  if (!Number.isSafeInteger(index) || index >= length) invalid("Array index out of range");
  return index;
}
function readAt(document: unknown, path: JsonPath): { exists: boolean; value: unknown } {
  let current = document;
  for (const segment of path) {
    if (!current || typeof current !== "object" || !own(current, segment)) return { exists: false, value: undefined };
    if (Array.isArray(current)) arrayIndex(segment, current.length);
    current = (current as Record<string, unknown>)[segment];
  }
  return { exists: true, value: current };
}
function parentOf(document: unknown, path: JsonPath): { parent: Record<string, unknown> | unknown[]; key: string } {
  const target = readAt(document, path.slice(0, -1));
  if (!target.exists || !target.value || typeof target.value !== "object") invalid("Path parent does not exist");
  return { parent: target.value as Record<string, unknown>, key: path.at(-1)! };
}
function applyOperation(document: unknown, operation: EditOperation): EditOperation {
  checkPath(operation.path);
  if (operation.kind === "set" || operation.kind === "delete") {
    const { parent, key } = parentOf(document, operation.path);
    const exists = own(parent, key), previous = exists ? structuredClone((parent as Record<string, unknown>)[key]) : undefined;
    if (Array.isArray(parent)) {
      const index = arrayIndex(key, parent.length);
      if (operation.kind === "delete") { parent.splice(index, 1); return { kind: "insert", path: operation.path.slice(0, -1), index, value: previous }; }
      parent[index] = structuredClone(operation.value);
    } else if (operation.kind === "delete") {
      if (!exists) invalid("Delete path does not exist");
      delete parent[key];
    } else parent[key] = structuredClone(operation.value);
    return exists ? { kind: "set", path: operation.path, value: previous } : { kind: "delete", path: operation.path };
  }
  const target = readAt(document, operation.path);
  if (!target.exists || !Array.isArray(target.value)) invalid("Operation target is not an array");
  if (operation.kind === "insert") {
    if (!Number.isSafeInteger(operation.index) || operation.index < 0 || operation.index > target.value.length) invalid("Insert index out of range");
    target.value.splice(operation.index, 0, structuredClone(operation.value));
    return { kind: "delete", path: [...operation.path, String(operation.index)] };
  }
  if (operation.kind !== "move") invalid("Unknown operation");
  for (const index of [operation.from, operation.to]) if (!Number.isSafeInteger(index) || index < 0 || index >= target.value.length) invalid("Move index out of range");
  const [item] = target.value.splice(operation.from, 1); target.value.splice(operation.to, 0, item);
  return { kind: "move", path: operation.path, from: operation.to, to: operation.from };
}
function validateTransaction(value: EditTransaction): void {
  assertJson(value);
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id.trim() || value.id.length > 160 || typeof value.projectId !== "string" || !Number.isSafeInteger(value.baseRevision) || value.baseRevision < 0 || !["user", "product-agent", "skill", "cli"].includes(value.actor) || typeof value.intent !== "string" || value.intent.length > 2000) invalid("Invalid transaction identity or actor");
  if (!value.scope || typeof value.scope !== "object" || Array.isArray(value.scope)) invalid("Invalid edit scope");
  if (value.scope.timeRange) invalid("Time-range scopes are not supported by SceneScript v1");
  if (value.scope.handles && (!Array.isArray(value.scope.handles) || value.scope.handles.some(h => typeof h !== "string" || !h))) invalid("Invalid scope handles");
  if (!Array.isArray(value.operations) || value.operations.length > 1000) invalid("Invalid operations");
  for (const op of value.operations) {
    if (!op || !["set", "delete", "insert", "move"].includes(op.kind)) invalid("Unknown operation");
    checkPath(op.path);
    if (["set", "insert"].includes(op.kind) && !own(op, "value")) invalid("Operation value is required");
    if (op.path[0] === "id" || op.path[0] === "schemaVersion") invalid("Project identity and schema version are immutable");
  }
  if (value.preconditions !== undefined && !Array.isArray(value.preconditions)) invalid("Invalid preconditions");
  for (const condition of value.preconditions ?? []) {
    checkPath(condition.path, true);
    if (condition.kind !== "exists" && condition.kind !== "equals" || condition.kind === "exists" && typeof condition.expected !== "boolean" || condition.kind === "equals" && !own(condition, "value")) invalid("Invalid precondition");
  }
}
export class ProjectSession<T extends object = Record<string, unknown>> {
  private document: T;
  private revision: number;
  private readonly history: SessionHistoryEntry[];
  private selection: string[];
  constructor(private readonly projectId: string, document: T, revision = 0, history: SessionHistoryEntry[] = [], selection: string[] = [], private readonly validate?: (document: T) => void) {
    if (!projectId.trim() || !Number.isSafeInteger(revision) || revision < 0) invalid("Invalid session identity");
    assertJson(document); this.validate?.(document);
    this.document = structuredClone(document); this.revision = revision; this.history = structuredClone(history); this.selection = [...selection];
  }
  private stacks(): { undo: SessionHistoryEntry[]; redo: SessionHistoryEntry[] } {
    const undo: SessionHistoryEntry[] = [], redo: SessionHistoryEntry[] = [];
    for (const entry of this.history) {
      if (entry.changed === false) continue;
      if (entry.action === "undo") { const item = undo.pop(); if (item) redo.push(item); }
      else if (entry.action === "redo") { const item = redo.pop(); if (item) undo.push(item); }
      else { undo.push(entry); redo.length = 0; }
    }
    return { undo, redo };
  }
  snapshot(): SessionSnapshot<T> { return { projectId: this.projectId, revision: this.revision, document: structuredClone(this.document), digest: digest(this.document) }; }
  look(): SessionLook { const stacks = this.stacks(); return { projectId: this.projectId, revision: this.revision, digest: digest(this.document), selection: [...this.selection], undoDepth: stacks.undo.length, redoDepth: stacks.redo.length }; }
  select(handles: string[]): void {
    if (!Array.isArray(handles) || handles.length > 100 || handles.some(h => typeof h !== "string" || !h)) invalid("Invalid selection");
    const scenes = (this.document as Record<string, unknown>).scenes;
    if (handles.length && (!Array.isArray(scenes) || handles.some(h => !scenes.some(s => s.id === h)))) invalid("Selection contains an unknown scene");
    this.selection = [...new Set(handles)];
  }
  inspect(path: JsonPath): { exists: boolean; value: unknown } { checkPath(path, true); return structuredClone(readAt(this.document, path)); }
  submit(transaction: EditTransaction, action: "edit" | "undo" | "redo" = "edit", target?: string): TaskReceipt {
    const base: TaskReceipt = { transactionId: typeof transaction?.id === "string" ? transaction.id : "", stage: "refused", projectId: this.projectId, baseRevision: transaction?.baseRevision, changed: false, affectedPaths: [], affectedHandles: [] };
    try {
      validateTransaction(transaction);
      base.affectedPaths = transaction.operations.map(op => op.path); base.affectedHandles = transaction.scope.handles ?? [];
      if (transaction.projectId !== this.projectId) invalid("Transaction belongs to another project");
      const prior = this.history.find(e => e.transaction.id === transaction.id);
      if (prior) {
        if (canonicalJson(prior.transaction) !== canonicalJson(transaction) || (prior.action ?? "edit") !== action) invalid("Transaction id was reused with different content");
        return this.receipt(prior);
      }
      if (transaction.baseRevision !== this.revision) throw new SessionError("revision-conflict", `Revision conflict: expected ${this.revision}, received ${transaction.baseRevision}`);
      for (const condition of transaction.preconditions ?? []) {
        const actual = readAt(this.document, condition.path);
        if (!(condition.kind === "exists" ? actual.exists === condition.expected : actual.exists && canonicalJson(actual.value) === canonicalJson(condition.value))) throw new SessionError("precondition-failed", `Precondition failed at ${condition.path.join(".")}`);
      }
      const next = structuredClone(this.document), inverse: EditOperation[] = [];
      for (const operation of transaction.operations) {
        const handles = transaction.scope.handles;
        if (handles?.length) {
          const scene = operation.path[0] === "scenes" && operation.path.length > 1 ? readAt(next, operation.path.slice(0, 2)).value as { id?: string } | undefined : undefined;
          if (!scene?.id || !handles.includes(scene.id) || operation.path.length === 2 || operation.path[2] === "id") invalid("Edit exceeds the selected scene scope");
        }
        inverse.unshift(applyOperation(next, operation));
      }
      this.validate?.(next);
      const changed = canonicalJson(next) !== canonicalJson(this.document);
      this.document = next; this.revision++;
      const entry: SessionHistoryEntry = { revision: this.revision, transaction: structuredClone(transaction), inverse, digest: digest(next), action, changed, ...(target ? { target } : {}) };
      this.history.push(entry);
      const scenes = (next as Record<string, unknown>).scenes;
      this.selection = this.selection.filter(h => Array.isArray(scenes) && scenes.some(s => s.id === h));
      return this.receipt(entry);
    } catch (error) { return { ...base, reason: error instanceof Error ? error.message : "Invalid edit" }; }
  }
  historyEdit(action: "undo" | "redo", id: string, baseRevision: number, actor: SessionActor): TaskReceipt {
    const existing = this.history.find(e => e.transaction.id === id);
    if (existing) {
      if (existing.action !== action || existing.transaction.baseRevision !== baseRevision || existing.transaction.actor !== actor) return { ...this.receipt(existing), stage: "refused", changed: false, reason: "Transaction id was reused with different content" };
      return this.receipt(existing);
    }
    const target = this.stacks()[action].at(-1);
    const transaction: EditTransaction = { id, projectId: this.projectId, baseRevision, actor, scope: {}, operations: target ? action === "undo" ? target.inverse : target.transaction.operations : [], intent: action };
    if (!target) return { transactionId: id, stage: "refused", projectId: this.projectId, baseRevision, changed: false, affectedPaths: [], affectedHandles: [], reason: `Nothing to ${action}` };
    return this.submit(transaction, action, target.transaction.id);
  }
  private receipt(entry: SessionHistoryEntry): TaskReceipt {
    return { transactionId: entry.transaction.id, stage: "dispatched", projectId: this.projectId, baseRevision: entry.transaction.baseRevision, revision: entry.revision, changed: entry.changed ?? true, affectedPaths: structuredClone(entry.transaction.operations.map(op => op.path)), affectedHandles: [...(entry.transaction.scope.handles ?? [])], digest: entry.digest };
  }
  verify(transactionId: string): TaskReceipt {
    const entry = this.history.find(e => e.transaction.id === transactionId);
    return entry ? { ...this.receipt(entry), reason: "Persistence readback is required" } : { transactionId, stage: "refused", projectId: this.projectId, baseRevision: this.revision, changed: false, affectedPaths: [], affectedHandles: [], reason: "Unknown transaction" };
  }
  exportState(): SessionState<T> { return structuredClone({ projectId: this.projectId, revision: this.revision, document: this.document, history: this.history, selection: this.selection }); }
}
export function pathFromDot(path: string): JsonPath { const segments = path.split(".").map(s => s.trim()); checkPath(segments); return segments; }
