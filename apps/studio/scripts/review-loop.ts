import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { reexplain, rehearse, type RehearsalReport } from "@glintai/listener";
import type { LlmProvider } from "@glintai/llm";
import { learningConfusions, learningRecords } from "./understanding";

/** Checkpoints each rewrite. An interrupted review resumes completed scenes, without touching the source. */
export async function reviewProjectLoop(options: { projectPath: string; out: string; llm: LlmProvider; feedback?: string; maxScenes?: number; verify?: boolean }, dependencies: { rehearse?: typeof rehearse; reexplain?: typeof reexplain } = {}) {
  const source = path.resolve(options.projectPath), out = path.resolve(options.out), checkpoint = `${out}.review.json`;
  if (source === out || path.dirname(source) !== path.dirname(out)) throw new Error("Review output must be a new sibling project (preserves original assets and source)");
  if (fs.existsSync(out)) throw new Error("Review output already exists");
  const maxScenes = options.maxScenes ?? 2; if (!Number.isInteger(maxScenes) || maxScenes < 1 || maxScenes > 10) throw new Error("max-scenes must be 1–10");
  const project = parseProject(JSON.parse(fs.readFileSync(source, "utf8")));
  const digest = createHash("sha256").update(JSON.stringify({ project, feedback: options.feedback ? learningRecords(options.feedback) : null, maxScenes, verify: options.verify })).digest("hex");
  let record: { digest: string; reports: RehearsalReport[]; targets: { sceneId: string; confusion: string }[]; scenes: Record<string, SceneScriptProject["scenes"][number]>; verification?: RehearsalReport[] };
  const save = () => { const temp = `${checkpoint}.tmp`; fs.writeFileSync(temp, JSON.stringify(record, null, 2)); fs.renameSync(temp, checkpoint); };
  if (fs.existsSync(checkpoint)) { record = JSON.parse(fs.readFileSync(checkpoint, "utf8")); if (record.digest !== digest) throw new Error("Review inputs changed; use a new output path"); }
  else {
    const reports = options.feedback ? [] : await (dependencies.rehearse ?? rehearse)(project, options.llm, { timeoutMs: 150000 });
    const confusions = options.feedback ? learningConfusions(project, learningRecords(options.feedback)) : reports.flatMap(r => r.confusions);
    const byScene = new Map<string, string[]>();
    for (const c of confusions) { if (!project.scenes.some(s => s.id === c.sceneId)) continue; const list = byScene.get(c.sceneId) ?? []; list.push(c.confusion); byScene.set(c.sceneId, list); }
    record = { digest, reports, targets: [...byScene].slice(0, maxScenes).map(([sceneId, items]) => ({ sceneId, confusion: items.join("\n") })), scenes: {} }; save();
  }
  let updated = structuredClone(project);
  for (const target of record.targets) {
    if (!record.scenes[target.sceneId]) {
      const next = await (dependencies.reexplain ?? reexplain)(updated, options.llm, { ...target, timeoutMs: 150000 });
      const scene = next.scenes.find(s => s.id === target.sceneId)!;
      // Keep image/video/media identity, notes and quiz stable across text rewrites.
      const original = project.scenes.find(s => s.id === target.sceneId)!;
      for (const field of ["src", "modelUrl", "notes", "quiz", "sharedElements", "camera", "transition", "beatPulse"] as const) {
        if (field in original) (scene as any)[field] = structuredClone((original as any)[field]);
        else delete (scene as any)[field];
      }
      record.scenes[target.sceneId] = scene; save();
    }
    updated = parseProject({ ...updated, scenes: updated.scenes.map(s => s.id === target.sceneId ? record.scenes[s.id]! : s) });
  }
  if (options.verify !== false && !record.verification) { record.verification = await (dependencies.rehearse ?? rehearse)(updated, options.llm, { timeoutMs: 150000 }); save(); }
  fs.writeFileSync(out, JSON.stringify(updated, null, 2), { flag: "wx" });
  return { output: out, changedScenes: record.targets.map(t => t.sceneId), remainingConfusions: record.verification?.flatMap(r => r.confusions).length ?? null, checkpoint };
}
