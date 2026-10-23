import { craftLint, lintVerdict } from "@glintai/composer";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";

export interface RepairChange { sceneId: string; field: string; before: unknown; after: unknown; reason: string }

/** Repairs presentation-only violations; narration, facts and user assets are never rewritten. */
export function repairPresentation(input: SceneScriptProject) {
  const project = structuredClone(input), changes: RepairChange[] = [];
  const issues = craftLint(project);
  for (const issue of issues) {
    if (issue.rule === "consecutive-push") {
      const scene = project.scenes.find(s => s.id === issue.sceneId)!;
      changes.push({ sceneId: scene.id, field: "camera.type", before: scene.camera?.type, after: "pull", reason: issue.rule });
      scene.camera = { ...scene.camera, type: "pull" };
    }
    if (issue.rule === "missing-shared-element") {
      const scene = project.scenes.find(s => s.id === issue.sceneId)!;
      changes.push({ sceneId: scene.id, field: "transition.in", before: "magic-move", after: "fade", reason: issue.rule });
      scene.transition = { ...scene.transition!, in: "fade" };
    }
  }
  let accentCount = 0;
  for (const scene of project.scenes) {
    if (!["flash", "zoom-punch"].includes(scene.transition?.in ?? "")) continue;
    if (++accentCount <= 2) continue;
    changes.push({ sceneId: scene.id, field: "transition.in", before: scene.transition!.in, after: "fade", reason: "accent-budget" });
    scene.transition = { ...scene.transition!, in: "fade" };
  }
  const validated = parseProject(project), remaining = craftLint(validated);
  return { project: validated, changes, issues: remaining, verdict: lintVerdict(remaining) };
}
