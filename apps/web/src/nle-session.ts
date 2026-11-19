import { ProjectSession, type SessionState } from "@glintai/session";
import { parseNleProject, type NleProject } from "@glintai/scenescript";
import { diffNleProjects } from "./nle-diff";
export { diffNleProjects } from "./nle-diff";

export interface NleSession {
  document(): NleProject;
  revision(): number;
  undoDepth(): number;
  redoDepth(): number;
  apply(next: NleProject, intent: string): { ok: true; document: NleProject } | { ok: false; reason: string };
  /** Live gestures stay outside history until the caller commits them. */
  amendTo(next: NleProject, reason?: string): void;
  undo(): boolean;
  redo(): boolean;
  exportState(): SessionState<NleProject>;
  restore(state: SessionState<NleProject>): void;
}

const HISTORY_LIMIT = 160;

export function createNleSession(initial: NleProject, restored?: SessionState<NleProject>): NleSession {
  let session = restored
    ? new ProjectSession<NleProject>(restored.projectId, restored.document, restored.revision, restored.history, undefined, document => { parseNleProject(document); })
    : new ProjectSession<NleProject>(initial.id, initial, 0, [], undefined, document => { parseNleProject(document); });
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
  const historyEdit = (action: "undo" | "redo"): boolean => {
    const receipt = session.historyEdit(action, nextId(action), session.look().revision, "user");
    return receipt.stage === "dispatched";
  };
  return {
    document: () => session.snapshot().document,
    revision: () => session.look().revision,
    undoDepth: () => session.look().undoDepth,
    redoDepth: () => session.look().redoDepth,
    apply(next, intent) {
      try {
        const operations = diffNleProjects(session.snapshot().document, next);
        if (!operations.length) return { ok: true, document: next };
        const receipt = session.submit({ id: nextId("edit"), projectId: session.look().projectId, baseRevision: session.look().revision, actor: "user", scope: {}, operations, intent });
        if (receipt.stage === "refused") return { ok: false, reason: receipt.reason ?? "事务被拒绝" };
        session.compactHistory(HISTORY_LIMIT);
        return { ok: true, document: session.snapshot().document };
      } catch (cause) {
        return { ok: false, reason: cause instanceof Error ? cause.message : "编辑事务失败" };
      }
    },
    amendTo(next, reason = "amended") {
      if (next.id !== session.look().projectId) {
        session = new ProjectSession<NleProject>(next.id, next, 0, [], undefined, document => { parseNleProject(document); });
        return;
      }
      session.amend(next, reason);
      session.compactHistory(HISTORY_LIMIT);
    },
    undo: () => historyEdit("undo"),
    redo: () => historyEdit("redo"),
    exportState: () => session.exportState(),
    restore(state) {
      const document=parseNleProject(state.document);
      if(state.projectId!==document.id)throw new Error("剪辑工程与历史身份不一致。");
      session=new ProjectSession<NleProject>(state.projectId,document,state.revision,state.history,undefined,next=>{parseNleProject(next);});
    },
  };
}
