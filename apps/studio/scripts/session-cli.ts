import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathFromDot, type EditOperation, type SessionActor } from "@glintai/session";
import { FileSessionStore } from "@glintai/session/node";
import { parseProject } from "@glintai/scenescript";

function arg(args: string[], name: string): string | undefined { return args.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3); }
function parseValue(value: string): unknown { try { return JSON.parse(value); } catch { return value; } }
export function runSession(args: string[]): void {
  const mode = args[0] && !args[0].startsWith("--") ? args[0] : "inspect";
  const store = new FileSessionStore(arg(args, "store"), document => { parseProject(document); });
  const projectFile = arg(args, "project");
  let projectId = arg(args, "id");
  if (projectFile) {
    const file = path.resolve(projectFile), document = parseProject(JSON.parse(fs.readFileSync(file, "utf8")));
    if (projectId && projectId !== document.id) throw new Error("--id does not match the project document");
    projectId = document.id;
    const opened = store.open(projectId, JSON.parse(fs.readFileSync(file, "utf8")), file);
    if (opened.conflict) throw new Error(`Local file differs from durable session revision ${opened.look.revision}; use --id=${projectId} to inspect that revision, or import the file under a new id`);
  }
  if (mode === "list") { console.log(JSON.stringify(store.list(), null, 2)); return; }
  if (!projectId) throw new Error("session requires --project=<project.json> or --id=<project-id>");
  let result: unknown;
  if (mode === "inspect") result = arg(args, "path") ? store.inspect(projectId, pathFromDot(arg(args, "path")!)) : store.snapshot(projectId).look;
  else if (mode === "open" || mode === "snapshot") result = store.snapshot(projectId);
  else if (mode === "verify") {
    const transactionId = arg(args, "transaction");
    if (!transactionId) throw new Error("session verify requires --transaction=<id>");
    const receipt = store.verify(projectId, transactionId); result = receipt;
    if (!["saved", "verified"].includes(receipt.stage)) process.exitCode = 2;
  } else if (["set", "apply", "undo", "redo"].includes(mode)) {
    const rawRevision = arg(args, "base-revision"), baseRevision = Number(rawRevision);
    if (rawRevision === undefined || !Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new Error("Editing requires --base-revision=<revision>");
    const id = arg(args, "transaction") ?? `tx-${randomUUID()}`, actor = (arg(args, "actor") ?? "skill") as SessionActor;
    if (mode === "undo" || mode === "redo") result = store.historyEdit(projectId, mode, id, baseRevision, actor);
    else {
      let operations: EditOperation[];
      if (mode === "apply") {
        const file = arg(args, "operations");
        if (!file) throw new Error("session apply requires --operations=<JSON operations file>");
        operations = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
      } else {
        const editPath = arg(args, "path"), value = arg(args, "value");
        if (!editPath) throw new Error("session set requires --path=<dot.path>");
        operations = [value === undefined ? { kind: "delete", path: pathFromDot(editPath) } : { kind: "set", path: pathFromDot(editPath), value: parseValue(value) }];
      }
      result = store.apply(projectId, { id, projectId, baseRevision, actor, scope: {}, operations, intent: arg(args, "intent") ?? `${mode} via CLI` });
    }
    if ((result as { receipt: { stage: string } }).receipt.stage === "refused") process.exitCode = 2;
  } else throw new Error(`Unknown session mode: ${mode}`);
  console.log(JSON.stringify(result, null, 2));
}
