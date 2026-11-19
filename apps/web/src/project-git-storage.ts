import {readNlePair,NLE_PROJECT_KEY,NLE_SESSION_KEY} from "./nle-storage";
import { nleRecordKey, parseNleRecord, serializeNleRecord } from "./nle-project-library";
import { createNleSession } from "./nle-session";
import { parseProject, parseProjectWorkspace, type ProjectWorkspace, type SceneScriptProject } from "@glintai/scenescript";
import { emptyGenCanvas, parseGenCanvas } from "@glintai/scenescript/gen-canvas";
import { readGenerationLayout } from "./gen-canvas-layout";
import { parseCanvasViewport } from "./canvas-viewport";
import { canonicalJson } from "@glintai/session";
import { designDocumentsKey, readProjectDesignDocuments, type ProjectDesignDocuments } from "./design-artifacts";
import { projectDocumentsKey, readProjectDocuments, validateProjectDocuments, type ProjectDocuments } from "./script-documents";
import { projectBrandKey, projectBrandRaw, readProjectBrandTheme } from "./design-brand";
import { projectAssetsKey, readProjectAssetsStrict } from "./design-asset-index";

import { acceptedWorkspaces, readWorkspace, assertLocalWorkspaceCurrent, saveLocalWorkspace, assertGitStorageReady, readGitProject, sameGitProject, gitProjectKey, type GitStorage } from "./project-workspace-storage";
export { assertLocalWorkspaceCurrent, saveLocalWorkspace, assertGitStorageReady, readGitProject, sameGitProject, gitProjectKey, type GitStorage } from "./project-workspace-storage";
type Entry = { key: string; before: string | null; after: string | null };
type Journal = { version: 1; entries: Entry[] } | { version: 2; projectId: string; state: "prepared" | "committed"; entries: Entry[] };
const journalKey = (id: string) => `glint:git-restore.v1:${id}`;
const activeKey = "glint:git-active-restore.v1";
const workspaceKey = "glint.workspace";
const boardKey = (id: string) => `glint:project-board:v1:${id}`;
const boardGroupsKey = (id:string) => `glint:project-board:groups:v1:${id}`;
const boardViewportKey = (id: string) => `glint:project-board:viewport:v1:${id}`;
const generationKey = (id: string) => `glint:gen-canvas:v1:${id}`;
const generationLayoutKey = (id: string) => `glint:gen-canvas:layout:v1:${id}`;
const generationViewportKey = (id: string) => `glint:gen-canvas:viewport:v1:${id}`;
const generationReceiptKey = (id: string, node: string) => `glint:gen-canvas:receipt:${id}:${node}`;
const keys = (id: string) => [projectDocumentsKey(id), designDocumentsKey(id), projectBrandKey(id), projectAssetsKey(id), gitProjectKey(id), boardKey(id), boardViewportKey(id), boardGroupsKey(id), generationKey(id), generationLayoutKey(id), generationViewportKey(id), nleRecordKey(id)];
const assign = (storage: GitStorage, key: string, value: string | null) => value === null ? storage.removeItem(key) : storage.setItem(key, value);
const cleanupWarning = "完整版本已保存到本机；恢复日志暂未清理，下次打开时会重试。共享服务端保存仍需单独确认。";
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
function readJournal(raw: string, projectId: string): Journal {
  try {
    if (bytes(raw) > 32 * 1024 * 1024) throw new Error();
    const value = JSON.parse(raw) as Journal;
    const v2 = value.version === 2;
    const allowed = v2 ? [...keys(projectId), workspaceKey,NLE_PROJECT_KEY,NLE_SESSION_KEY] : keys(projectId).slice(0, 4);
    if (value.version !== 1 && !v2 || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > allowed.length + (v2 ? 60 : 0) ||
      Object.keys(value).some(key => !(v2 ? ["version", "projectId", "state", "entries"] : ["version", "entries"]).includes(key)) ||
      new Set(value.entries.map(entry => entry?.key)).size !== value.entries.length || value.entries.some(entry => !entry || !(allowed.includes(entry.key) || v2 && typeof entry.key === "string" && entry.key.startsWith(generationReceiptKey(projectId, "")) && /^[a-z0-9][a-z0-9-]{0,40}$/.test(entry.key.slice(generationReceiptKey(projectId, "").length))) ||
      Object.keys(entry).some(key => !["key", "before", "after"].includes(key)) || ![entry.before, entry.after].every(item => item === null || typeof item === "string"))) throw new Error();
    if (v2) {
      if (value.projectId !== projectId || !["prepared", "committed"].includes(value.state)) throw new Error();
      const nleProject=value.entries.find(entry=>entry.key===NLE_PROJECT_KEY),nleSession=value.entries.find(entry=>entry.key===NLE_SESSION_KEY);
      if(nleProject||nleSession){
        if(!nleProject?.after||!nleSession?.after)throw new Error();
        const raw=value.entries.find(entry=>entry.key===nleRecordKey(projectId))?.after;if(!raw)throw new Error();
        const record=parseNleRecord(raw,projectId);if(record.pair.project!==nleProject.after||record.pair.session!==nleSession.after)throw new Error();
      }
      const projectRaw = value.entries.find(entry => entry.key === gitProjectKey(projectId))?.after;
      const workspaceRaw = value.entries.find(entry => entry.key === workspaceKey)?.after;
      if (projectRaw !== undefined || workspaceRaw !== undefined) {
        if (!projectRaw || !workspaceRaw || parseProject(JSON.parse(projectRaw)).id !== projectId ||
          JSON.stringify(JSON.parse(workspaceRaw).project) !== JSON.stringify(JSON.parse(projectRaw))) throw new Error();
      }
    }
    return value;
  } catch { throw new Error("上次版本恢复日志损坏；请保留数据并导出备份，未覆盖当前存储。"); }
}

function cleanup(projectId: string, raw: string, storage: GitStorage): string | undefined {
  try {
    const current = storage.getItem(journalKey(projectId));
    if (current !== null && current !== raw) return "恢复日志已被其他窗口更新，未清理对方日志；请先备份并核对。";
    if (current !== null) storage.removeItem(journalKey(projectId));
    // A silent failed delete must not release the autosave barrier while a prepared log remains.
    if (storage.getItem(journalKey(projectId)) !== null) return cleanupWarning;
    if (storage.getItem(activeKey) === projectId) {
      storage.removeItem(activeKey);
      if (storage.getItem(activeKey) !== null) return cleanupWarning;
    }
    return undefined;
  } catch { return cleanupWarning; }
}

/** Prepared writes roll back; committed writes are never undone merely because cleanup failed. */
export function recoverGitStorage(projectId: string, storage: GitStorage = localStorage): void {
  const raw = storage.getItem(journalKey(projectId));
  if (raw === null) return;
  const journal = readJournal(raw, projectId), committed = journal.version === 2 && journal.state === "committed";
  if (!committed) {
    for (const entry of journal.entries) {
      const current = storage.getItem(entry.key);
      if (current !== entry.before && current !== entry.after)
        throw new Error("上次恢复中断后其他窗口更新了文档；未自动覆盖，请先备份并核对。");
    }
    for (const entry of [...journal.entries].reverse()) {
      if (storage.getItem(journalKey(projectId)) !== raw) throw new Error("其他窗口替换了恢复日志；已停止回退，请先备份并核对。");
      const current = storage.getItem(entry.key);
      if (current !== entry.before && current !== entry.after) throw new Error("回退期间其他窗口更新了文档；恢复日志已保留，未覆盖对方修改。");
      if (current !== entry.before) assign(storage, entry.key, entry.before);
      if (storage.getItem(entry.key) !== entry.before) throw new Error("回退写入未通过核对；恢复日志已保留，请恢复存储权限后重试。");
    }
    // Recheck the whole rollback before discarding its only durable before-images.
    if (journal.entries.some(entry => storage.getItem(entry.key) !== entry.before))
      throw new Error("回退完成前文档再次变化；恢复日志已保留，请先备份并核对。");
    // Completed rollback is consistent even when only journal cleanup remains blocked.
    cleanup(projectId, raw, storage);
  } else cleanup(projectId, raw, storage);
}

/** Startup follows the journal target even when a new copy had not yet updated the global workspace. */
export function recoverGitWorkspace(storage: GitStorage = localStorage): Record<string, unknown> | null {
  const active = storage.getItem(activeKey);
  if (active !== null) {
    if (!/^[a-z0-9][a-z0-9-]{0,199}$/.test(active)) throw new Error("本机恢复目标编号无效；请保留备份并核对。");
    recoverGitStorage(active, storage);
    if (storage.getItem(journalKey(active)) === null && storage.getItem(activeKey) === active) {
      try { storage.removeItem(activeKey); } catch { /* A stale pointer is safe to retry at next startup. */ }
    }
  }
  const workspace = readWorkspace(storage);
  const projectId = workspace?.project && typeof workspace.project === "object" ? (workspace.project as { id?: unknown }).id : undefined;
  if (typeof projectId === "string") recoverGitStorage(projectId, storage);
  return readWorkspace(storage);
}

export function captureProjectWorkspace(projectId: string, designs?: ProjectDesignDocuments, storage: GitStorage = localStorage): ProjectWorkspace {
  recoverGitStorage(projectId, storage);
  // Even an in-memory draft does not grant permission to overwrite corrupt disk data.
  const stored = parseProjectWorkspace({ version: 1, projectId, designs: readProjectDesignDocuments(projectId, storage),
    brand: readProjectBrandTheme(projectId, storage), assets: readProjectAssetsStrict(projectId, storage), ...readBoard(projectId, storage), ...readGeneration(projectId, storage), ...readTimeline(projectId, storage) }, projectId);
  return designs === undefined ? stored : parseProjectWorkspace({ ...stored, designs }, projectId);
}

function readTimeline(projectId:string,storage:GitStorage):Pick<ProjectWorkspace,"timeline">{
 if(storage.getItem("glint.nle.save.v1")!==null)throw new Error("剪辑保存日志待恢复，请先重新打开剪辑台再备份工程。");
 const raw=storage.getItem(nleRecordKey(projectId));if(raw===null)return{};
 const record=parseNleRecord(raw,projectId);
 return{timeline:{project:JSON.parse(record.pair.project!),bridge:record.bridge}};
}

function readGeneration(projectId: string, storage: GitStorage): Pick<ProjectWorkspace, "generation"> {
  const raw = storage.getItem(generationKey(projectId)), layout = storage.getItem(generationLayoutKey(projectId)), view = storage.getItem(generationViewportKey(projectId));
  if (raw === null && layout === null && view === null) return {};
  try {
    const canvas = raw === null ? emptyGenCanvas() : parseGenCanvas(JSON.parse(raw));
    const receipts: NonNullable<ProjectWorkspace["generation"]>["receipts"] = {};
    for (const node of canvas.nodes) {
      const saved = storage.getItem(generationReceiptKey(projectId, node.id));
      if (saved === null) continue;
      const receipt = JSON.parse(saved);
      if (receipt.nodeCreatedAt !== node.createdAt && receipt.isFinal === true) continue;
      receipts[node.id] = receipt;
    }
    const viewport = parseCanvasViewport(view);
    return { generation: { canvas, positions: readGenerationLayout(layout), receipts, ...(viewport ? {viewport} : {}) } };
  } catch { throw new Error("生成画布或任务回执损坏；请先备份，未覆盖原记录。"); }
}

function readBoard(projectId: string, storage: GitStorage): Pick<ProjectWorkspace,"board"> {
  const positions = storage.getItem(boardKey(projectId)), viewport = storage.getItem(boardViewportKey(projectId)), groups=storage.getItem(boardGroupsKey(projectId));
  if (positions === null && viewport === null && groups === null) return {};
  try { return { board: { positions: positions === null ? {} : JSON.parse(positions), ...(viewport === null ? {} : { viewport: JSON.parse(viewport) }), ...(groups===null?{}:{groups:JSON.parse(groups)}) } }; }
  catch { throw new Error("项目画布记录损坏；请先备份，未覆盖原记录。"); }
}

/** Read the last accepted main snapshot and current attachments without replaying any journal. */
export function readLocalGitVersion(projectId: string, storage: GitStorage = localStorage): {
  project: SceneScriptProject; assertCurrent(): void;
} {
  assertGitStorageReady(projectId, storage);
  const before = keys(projectId).map(key => ({ key, raw: storage.getItem(key) }));
  const project = readGitProject(projectId, storage);
  if (!project) throw new Error("完整本机主快照已不存在，未载入旧版本。");
  const generationRaw = before.find(entry => entry.key === generationKey(projectId))?.raw;
  if (generationRaw) for (const node of parseGenCanvas(JSON.parse(generationRaw)).nodes) {
    const key = generationReceiptKey(projectId, node.id); before.push({key, raw: storage.getItem(key)});
  }
  readProjectDocuments(projectId, storage);
  parseProjectWorkspace({ version: 1, projectId, designs: readProjectDesignDocuments(projectId, storage),
    brand: readProjectBrandTheme(projectId, storage), assets: readProjectAssetsStrict(projectId, storage), ...readBoard(projectId, storage), ...readGeneration(projectId, storage), ...readTimeline(projectId, storage) }, projectId);
  const assertCurrent = () => {
    assertGitStorageReady(projectId, storage);
    if(storage.getItem("glint.nle.save.v1")!==null)throw new Error("剪辑保存日志待恢复，未接受过期工程快照。");
    if (before.some(entry => storage.getItem(entry.key) !== entry.raw)) throw new Error("本机工程或附件已变化，未载入过期版本。");
  };
  assertCurrent();
  return { project, assertCurrent };
}

/** All disk values and a durable commit marker precede React acceptance. Cleanup is not the commit point. */
export function prepareGitStorage(projectId: string, documents: ProjectDocuments | undefined, workspace: ProjectWorkspace | undefined,
  storage: GitStorage = localStorage, copy = false, project?: SceneScriptProject): { write(): void; commit(): void; finish(): string | undefined; rollback(): void } {
  if (project) recoverGitWorkspace(storage);
  recoverGitStorage(projectId, storage);
  if (storage.getItem(journalKey(projectId)) !== null || project && storage.getItem(activeKey) !== null)
    throw new Error("上次版本恢复日志尚未清理，请恢复存储权限并核对后重试。");
  const values = new Map<string, string | null>();
  if (documents) {
    validateProjectDocuments(documents, projectId); readProjectDocuments(projectId, storage);
    values.set(projectDocumentsKey(projectId), JSON.stringify(documents));
  }
  if (workspace) {
    const valid = parseProjectWorkspace(workspace, projectId);
    const current = captureProjectWorkspace(projectId, undefined, storage);
    if(valid.timeline){
      const timeline=valid.timeline,session=createNleSession(timeline.project);
      // Version snapshots restore content, not this machine's gesture/undo history.
      const next={project:JSON.stringify(timeline.project),session:JSON.stringify(session.exportState())};
      values.set(nleRecordKey(projectId),serializeNleRecord(next,timeline.bridge));
      const active=readNlePair(storage);
      if(active.project!==null&&JSON.parse(active.project).id===projectId){
        const existing=storage.getItem(nleRecordKey(projectId));
        if(existing!==null){const record=parseNleRecord(existing,projectId);if(record.pair.project!==active.project||record.pair.session!==active.session)throw new Error("当前剪辑与工程库记录不一致，未覆盖恢复。");}
        else serializeNleRecord(active,null);
        values.set(NLE_PROJECT_KEY,next.project);values.set(NLE_SESSION_KEY,next.session!);
      }
    }
    for (const node of current.generation?.canvas.nodes ?? []) {
      const key = generationReceiptKey(projectId, node.id); values.set(key, storage.getItem(key));
    }
    // A version restore cannot erase the only receipt of a paid, unresolved request.
    for (const [nodeId, receipt] of Object.entries(current.generation?.receipts ?? {})) {
      const target = valid.generation?.receipts[nodeId];
      if (!receipt.isFinal && canonicalJson(receipt) !== canonicalJson(target ?? null))
        throw new Error("生成任务仍待确认；请先查询任务状态，再恢复版本，未覆盖任务回执。");
    }
    const generation = valid.generation;
    for (const [key, value] of [
      [generationKey(projectId), generation?.canvas],
      [generationLayoutKey(projectId), generation?.positions],
      [generationViewportKey(projectId), generation?.viewport],
    ] as const) if (value !== undefined || storage.getItem(key) !== null) values.set(key, value === undefined ? null : JSON.stringify(value));
    for (const [nodeId, receipt] of Object.entries(generation?.receipts ?? {})) {
      const key = generationReceiptKey(projectId, nodeId), existing = storage.getItem(key);
      // Do not rewind a receipt which has progressed since the saved version.
      if (existing !== null) {
        const saved = JSON.parse(existing);
        if (saved.requestId !== receipt.requestId || saved.nodeCreatedAt !== receipt.nodeCreatedAt || saved.isFinal && !receipt.isFinal || saved.taskId && saved.taskId !== receipt.taskId)
          throw new Error("本机生成任务比历史版本更新；请创建独立副本，未回退任务回执。");
      }
      values.set(key, JSON.stringify(receipt));
    }
    values.set(designDocumentsKey(projectId), JSON.stringify(valid.designs));
    values.set(projectBrandKey(projectId), valid.brand === null ? null : projectBrandRaw(valid.brand));
    values.set(projectAssetsKey(projectId), JSON.stringify(valid.assets));
    if (valid.board || storage.getItem(boardKey(projectId)) !== null)
      values.set(boardKey(projectId), valid.board ? JSON.stringify(valid.board.positions) : null);
    if(valid.board?.groups || storage.getItem(boardGroupsKey(projectId))!==null)
      values.set(boardGroupsKey(projectId),valid.board?.groups?JSON.stringify(valid.board.groups):null);
    if (valid.board?.viewport || storage.getItem(boardViewportKey(projectId)) !== null)
      values.set(boardViewportKey(projectId), valid.board?.viewport ? JSON.stringify(valid.board.viewport) : null);
  }
  if (project) {
    const valid = parseProject(project);
    if (valid.id !== projectId) throw new Error("恢复工程编号不匹配。");
    const raw = JSON.stringify(valid);
    if (bytes(raw) > 2 * 1024 * 1024) throw new Error("恢复工程超过本机保存上限。");
    const previous = readWorkspace(storage);
    values.set(gitProjectKey(projectId), raw);
    // Source/evidence/tool metadata stays untouched. The effective canvas must belong to
    // this accepted project, not the previous project's independent aspect selector.
    const combined = JSON.stringify({ ...(previous ?? { mode: "source", text: "", template: "explainer" }), aspect: valid.aspect, project: valid });
    if (bytes(combined) > 4 * 1024 * 1024) throw new Error("合并后的本机工作区过大，请先导出备份。");
    values.set(workspaceKey, combined);
  }
  const entries = [...values].map(([key, after]) => ({ key, before: storage.getItem(key), after }));
  const collision = () => copy && [...new Set([...keys(projectId), ...values.keys()])].some(key => ![workspaceKey,NLE_PROJECT_KEY,NLE_SESSION_KEY].includes(key) && storage.getItem(key) !== null);
  if (collision()) throw new Error("副本编号已存在本机数据，未覆盖；请重新创建独立副本。");
  let started = false, done = false, committed = false, ownedRaw = "";
  const journal = (state: "prepared" | "committed"): Journal => ({ version: 2, projectId, state, entries });
  const persist = (state: "prepared" | "committed") => {
    const raw = JSON.stringify(journal(state));
    if (bytes(raw) > 32 * 1024 * 1024) throw new Error("恢复日志超过本机保存上限。");
    if (started && storage.getItem(journalKey(projectId)) !== ownedRaw) throw new Error("其他窗口替换了恢复日志，已停止操作。");
    storage.setItem(journalKey(projectId), raw);
    // A silent dropped write leaves the previous owned marker valid for rollback.
    if (storage.getItem(journalKey(projectId)) !== raw) throw new Error("恢复日志写入未通过核对。");
    ownedRaw = raw;
  };
  function rollback() {
    if (!started || done) return;
    if (storage.getItem(journalKey(projectId)) !== ownedRaw) throw new Error("其他窗口替换了恢复日志，未覆盖对方数据。");
    // Explicit rejection before finish may undo a committed marker; startup never does so.
    if (committed) { persist("prepared"); committed = false; }
    recoverGitStorage(projectId, storage); started = false;
    acceptedWorkspaces.delete(storage);
  }
  return {
    write() {
      if (started || done || !entries.length) return;
      if(workspace?.timeline&&storage.getItem("glint.nle.save.v1")!==null)throw new Error("剪辑保存日志待恢复，未恢复工程版本。");
      if (collision()) throw new Error("副本编号已存在本机数据，未覆盖；请重新创建独立副本。");
      for (const entry of entries) if (storage.getItem(entry.key) !== entry.before) throw new Error("其他窗口在恢复前更新了工程附件，未写入任何恢复内容。");
      if (storage.getItem(journalKey(projectId)) !== null || project && storage.getItem(activeKey) !== null) throw new Error("其他窗口正在恢复版本，未写入任何恢复内容。");
      persist("prepared"); started = true;
      try {
        if (project) {
          storage.setItem(activeKey, projectId);
          if (storage.getItem(activeKey) !== projectId) throw new Error("恢复目标写入未通过核对。");
        }
        for (const entry of entries) {
          if (storage.getItem(journalKey(projectId)) !== ownedRaw || storage.getItem(entry.key) !== entry.before) throw new Error("恢复期间检测到其他窗口修改；已停止并保留恢复日志。");
          assign(storage, entry.key, entry.after);
          if (storage.getItem(entry.key) !== entry.after) throw new Error("恢复写入未通过核对。");
        }
      } catch (cause) {
        try { rollback(); } catch { throw new Error("恢复写入失败且回退尚未完成；恢复日志已保留。请勿关闭备份，恢复存储权限后重新打开工程。"); }
        throw cause;
      }
    },
    commit() {
      if (!started || done || committed) return;
      for (const entry of entries) if (storage.getItem(entry.key) !== entry.after) throw new Error("提交恢复前其他窗口更新了数据；未报告恢复成功。");
      persist("committed");
      committed = true;
    },
    finish() {
      if (!started || done) return;
      // Legacy attachment-only callers also persist the accepted marker, without widening v1 recovery scope.
      if (!committed) {
        persist("committed");
        committed = true;
      }
      done = true;
      const main = entries.find(entry => entry.key === workspaceKey);
      if (main?.after && storage.getItem(workspaceKey) === main.after) {
        const previous = acceptedWorkspaces.get(storage);
        acceptedWorkspaces.set(storage, { before: previous?.after === main.before ? previous.before : main.before, after: main.after });
      }
      return cleanup(projectId, ownedRaw, storage);
    },
    rollback,
  };
}
