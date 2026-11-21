import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SessionStoreError, type FileSessionStore } from "@glintai/session/node";
import { createProjectContainerStore, parseStoredContainer } from "./project-container-session";
import { isContainerDocument } from "@glintai/scenescript/project-container-v2";
import { dispatchContainerAction, containerRequestObject as object, containerRequestId as id } from "./project-container-actions";
import { PlanPreviewError, parsePlanPreviewIntent, previewContainerPlan } from "./project-plan-preview";
import { modelSettingsFile } from "./model-settings-path";

type Helpers = { readBody(req: IncomingMessage, signal: AbortSignal, maxBytes: number): Promise<string>; sendJson(res: ServerResponse, status: number, body: unknown): unknown };
type ProjectListRow = { projectId: string; revision: number; title: string; sceneCount: number; timelineCount: number; firstDocumentId?: string };
function pageParameters(query: URLSearchParams) {
  for (const key of query.keys()) if (!["limit", "cursor"].includes(key) || query.getAll(key).length !== 1) throw new Error("Invalid list query");
  const limit = query.get("limit") ?? "20";
  if (!/^[1-9][0-9]?$/.test(limit) || Number(limit) > 50) throw new Error("Invalid list limit");
  return { limit: Number(limit), cursor: query.has("cursor") ? id(query.get("cursor")) : undefined };
}
function listProjects(store: FileSessionStore, limit: number, cursor: string | undefined, signal: AbortSignal) {
  // list() scans the existing store. Only response metadata is bounded; this is not an index.
  const ids = [...new Set(store.list().map(row => row.projectId))].filter(value => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (cursor !== undefined && !ids.includes(cursor)) throw new Error("Unknown list cursor");
  const projects: ProjectListRow[] = [];
  for (const projectId of ids) {
    if (cursor !== undefined && projectId <= cursor) continue;
    signal.throwIfAborted();
    try {
      const { snapshot } = store.snapshot(projectId), project = parseStoredContainer(snapshot.document);
      if (project.id !== projectId || snapshot.projectId !== projectId) continue;
      const documents = project.objects.filter(object => isContainerDocument(object.kind) && !("archived" in object && object.archived)), first = documents[0];
      const payload = first && project.versions.find(version => version.id === first.currentVersionId && version.objectId === first.id)?.payload;
      const title = payload && typeof payload === "object" && "title" in payload && typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : projectId;
      projects.push({ projectId, revision: snapshot.revision, title: Array.from(title).slice(0, 160).join(""), sceneCount: documents.filter(object => object.kind === "scene-document").length, timelineCount: documents.filter(object => object.kind === "timeline-document").length, ...(first ? { firstDocumentId: first.id } : {}) });
    } catch { continue; } // Corrupt, busy or concurrently removed records are not readable projects.
    if (projects.length > limit) break;
  }
  const more = projects.length > limit; if (more) projects.pop();
  return { projects, nextCursor: more ? projects.at(-1)!.projectId : null };
}

/** Called only after the host server's authentication, origin and base-path guards. */
export function createProjectContainerRoutes(storeFactory: () => FileSessionStore = () => createProjectContainerStore(path.join(path.dirname(modelSettingsFile("llm")), "project-containers"))) {
  let stored: FileSessionStore | undefined;
  const store = () => stored ??= storeFactory();
  return async (req: IncomingMessage, res: ServerResponse, url: URL, helpers: Helpers): Promise<boolean> => {
    // K-03: the read-only plan preview rides the same handler so it shares one
    // store instance (and its writer lock) with every container action.
    const planPreview = url.pathname === "/api/project/plan-preview";
    if (!url.pathname.startsWith("/api/project-containers/") && !planPreview) return false;
    const action = planPreview ? "plan-preview" : url.pathname.slice("/api/project-containers/".length);
    const send = (status: number, body: unknown) => { if (!res.destroyed) helpers.sendJson(res, status, body); return true; };
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(65_000)]);
    const stop = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", stop);
    try {
      if (action === "plan-preview") {
        if (req.method !== "POST") return send(405, { error: "Use POST for plan preview" });
        const body = object(JSON.parse(await helpers.readBody(req, signal, 8 * 1024)));
        id(body.projectId);
        signal.throwIfAborted();
        // Read-only: snapshot + pure prediction. Nothing is written, no manifest is created.
        const { snapshot } = store().snapshot(id(body.projectId));
        return send(200, previewContainerPlan({ projectId: snapshot.projectId, revision: snapshot.revision, document: snapshot.document }, parsePlanPreviewIntent(body.intent)));
      }
      if (action === "list") {
        if (req.method !== "GET") return send(405, { error: "Use GET for list" });
        const { limit, cursor } = pageParameters(url.searchParams);
        return send(200, listProjects(store(), limit, cursor, signal));
      }
      if (action === "snapshot") {
        if (req.method !== "GET") return send(405, { error: "Use GET for snapshot" });
        return send(200, store().snapshot(id(url.searchParams.get("projectId"))));
      }
      if (!["open", "append", "undo", "redo", "lifecycle", "migrate-copy"].includes(action)) return send(404, { error: "Unknown project action" });
      if (req.method !== "POST") return send(405, { error: "Use POST for changes" });
      const body = object(JSON.parse(await helpers.readBody(req, signal, 16 * 1024 * 1024)));
      id(body.projectId);
      signal.throwIfAborted();
      const result = await dispatchContainerAction(store, action, body);
      return send("receipt" in result && result.receipt.stage === "refused" ? 409 : 200, result);
    } catch (error) {
      if (error instanceof PlanPreviewError) return send(error.status, { error: error.message });
      const code = error instanceof SessionStoreError ? error.code : "invalid-request";
      const status = (error as { status?: number })?.status === 413 ? 413 : code === "not-found" ? 404 : ["busy", "external-change", "project-conflict", "untrusted-import"].includes(code) ? 409 : code === "corrupt" ? 500 : 400;
      return send(status, { code, error: code === "corrupt" ? "Saved project validation failed; keep the original and restore a verified backup" : "Project request refused; check the document, revision and approval state" });
    } finally { res.off("close", stop); }
  };
}
