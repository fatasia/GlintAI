import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildTimeline, editTimeline, parseProject, type TimelineCommand } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
import { readArg } from "./glint-runtime";

function required(args: string[], name: string): string {
  const value = readArg(args, name);
  if (!value?.trim()) throw new Error(`timeline requires --${name}=...`);
  return value;
}
function milliseconds(args: string[], name: string): number {
  const raw = required(args, name), value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`--${name} must be an integer in milliseconds`);
  return value;
}

export function timelineCommand(args: string[]): TimelineCommand {
  const type = required(args, "op"), sceneId = required(args, "scene");
  switch (type) {
    case "lock": {
      const raw = required(args, "locked");
      if (!["true", "false"].includes(raw)) throw new Error("--locked must be true or false");
      return { type, sceneId, locked: raw === "true" };
    }
    case "ripple-delete": return { type, sceneId };
    case "trim": {
      const edge = required(args, "edge");
      if (edge !== "start" && edge !== "end") throw new Error("--edge must be start or end");
      return { type, sceneId, edge, deltaMs: milliseconds(args, "delta-ms") };
    }
    case "roll": case "slip": return { type, sceneId, deltaMs: milliseconds(args, "delta-ms") };
    case "split": return { type, sceneId, atMs: milliseconds(args, "at-ms"), newSceneId: required(args, "new-id"), duplicateText: args.includes("--duplicate-text") };
    default: throw new Error("Unknown timeline operation: use lock/ripple-delete/trim/roll/slip/split");
  }
}

/** All mutations use the shared durable session; there is no separate CLI writer/history. */
export function runTimeline(args: string[]) {
  const projectPath = readArg(args, "project");
  let projectId = readArg(args, "id");
  const store = new FileSessionStore(readArg(args, "store"), document => { parseProject(document); });
  if (projectPath) {
    const file = path.resolve(projectPath), raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const project = parseProject(raw);
    if (projectId && projectId !== project.id) throw new Error("--id does not match project id");
    projectId = project.id;
    if (store.open(projectId, raw, file).conflict) throw new Error("Project differs from its shared session; inspect --id before editing");
  }
  if (!projectId) throw new Error("timeline requires --project=<file> or --id=<shared-id>");
  if (!readArg(args, "op") || readArg(args, "op") === "list") {
    const current = store.snapshot(projectId);
    const timeline = buildTimeline(parseProject(current.snapshot.document));
    const result = { projectId, revision: current.look.revision, totalMs: timeline.totalMs,
      scenes: timeline.entries.map(entry => ({ id: entry.scene.id, kind: entry.scene.kind, startMs: entry.startMs, durationMs: entry.durationMs, locked: Boolean(entry.scene.locked) })) };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const baseRevision = milliseconds(args, "base-revision");
  if (baseRevision < 0) throw new Error("--base-revision must be non-negative");
  const command = timelineCommand(args);
  const result = store.applyTransform(projectId, {
    id: readArg(args, "transaction") ?? `timeline-${randomUUID()}`,
    baseRevision, actor: "cli", scope: {}, intent: `timeline:${JSON.stringify(command)}`,
  }, document => [{ kind: "set", path: ["scenes"], value: editTimeline(parseProject(document), command).scenes }]);
  if (result.receipt.stage === "refused" || result.receipt.stage === "failed") throw new Error(result.receipt.reason ?? "Timeline transaction refused");
  console.log(JSON.stringify({ receipt: result.receipt, look: result.look }, null, 2));
  return result;
}
