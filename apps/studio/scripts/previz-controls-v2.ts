import {
  animatedPrevizHtml,
  evaluatePrevizFrame,
  parsePrevizDocument,
  projectSkeleton,
} from "../../../packages/previz/src/index";
import type { ControlMode } from "./previz-controls-html";
import type { ControlOptions, planPrimitiveControlFrame } from "./previz-controls";

/** Reuses v1 frame/resource bounds and the existing capture pipeline; v1 actor rejection stays intact. */
export function planAnimatedControlFrame(
  input: unknown,
  options: ControlOptions,
  primitive: typeof planPrimitiveControlFrame,
) {
  const doc = parsePrevizDocument(input);
  if (doc.schemaVersion !== 2) throw new Error("Expected previz v2");
  const shot = doc.shots.find((item) => item.id === options.shot);
  if (!shot) throw new Error("shot-not-found");
  const tMs = Math.round((options.frame * 1000) / doc.fps);
  const { document } = evaluatePrevizFrame(doc, Math.max(0, tMs));
  const baseline = primitive(
    { ...document, actors: [], shots: document.shots.map((item) => ({ ...item, subjectIds: [] })) },
    options,
  );
  const { near, far } = baseline.metadata;
  const modes: ControlMode[] = ["rgb", "depth", "normal", "skeleton"];
  const first = baseline.project.scenes[0]!;
  const scenes = modes.map((mode) => ({
    ...first,
    id: mode,
    html: animatedPrevizHtml(doc, shot.cameraId, tMs, near, far, mode),
  }));
  return {
    ...baseline,
    project: { ...baseline.project, scenes },
    metadata: {
      ...baseline.metadata,
      format: "glint-previz-controls-v2" as const,
      documentId: doc.id,
      scope: "original procedural joint rig and primitive geometry; no external character assets",
      skeleton: {
        encoding: "white projected joint spheres/bones on black RGB8",
        timeMs: tMs,
        actors: projectSkeleton(doc, shot.cameraId, tMs),
      },
    },
  };
}
