import { z } from "zod";
import { GltfAssetPath, LocalAssetPath } from "./assets";

export const SCENESCRIPT_VERSION = 1;

const kebabId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case (lowercase letters, digits, hyphens)");

export const AspectRatio = z.enum(["16:9", "9:16", "1:1"]);
export type AspectRatio = z.infer<typeof AspectRatio>;

export const WordTiming = z.object({
  text: z.string().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
});
export type WordTiming = z.infer<typeof WordTiming>;

export const NarrationSegment = z.object({
  text: z.string().min(1),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().positive().optional(),
  words: z.array(WordTiming).optional(),
});
export type NarrationSegment = z.infer<typeof NarrationSegment>;

export const Narration = z.object({
  text: z.string().min(1, "narration text must not be empty"),
  voice: z.string().min(1).optional(),
  speakingRate: z.number().min(0.5).max(2).optional(),
  /** Static asset path inside the render workspace, set when audio exists. */
  audioRef: z.string().min(1).optional(),
  durationMs: z.number().int().positive().optional(),
  segments: z.array(NarrationSegment).optional(),
});
export type Narration = z.infer<typeof Narration>;

const sceneBase = {
  id: kebabId,
  narration: Narration,
};

export const TitleScene = z.object({
  ...sceneBase,
  kind: z.literal("title"),
  title: z.string().min(1),
  subtitle: z.string().optional(),
});

export const BulletsScene = z.object({
  ...sceneBase,
  kind: z.literal("bullets"),
  heading: z.string().optional(),
  items: z.array(z.string().min(1)).min(1),
});

export const DefinitionScene = z.object({
  ...sceneBase,
  kind: z.literal("definition"),
  term: z.string().min(1),
  definition: z.string().min(1),
});

export const QuoteScene = z.object({
  ...sceneBase,
  kind: z.literal("quote"),
  text: z.string().min(1),
  attribution: z.string().optional(),
});

const ComparisonSide = z.object({
  label: z.string().min(1),
  points: z.array(z.string().min(1)).min(1),
});

export const ComparisonScene = z.object({
  ...sceneBase,
  kind: z.literal("comparison"),
  heading: z.string().optional(),
  left: ComparisonSide,
  right: ComparisonSide,
});

export const CodeScene = z.object({
  ...sceneBase,
  kind: z.literal("code"),
  heading: z.string().optional(),
  code: z.string().min(1),
  language: z.string().min(1).optional(),
  caption: z.string().optional(),
});

export const ThreeScene = z.discriminatedUnion("model", [
  z.object({
    ...sceneBase,
    kind: z.literal("three"),
    model: z.enum(["torus-knot", "icosahedron", "sphere"]),
    caption: z.string().optional(),
  }),
  z.object({
    ...sceneBase,
    kind: z.literal("three"),
    model: z.literal("gltf"),
    src: GltfAssetPath,
    caption: z.string().optional(),
  }),
]);

export const ImageScene = z.object({
  ...sceneBase,
  kind: z.literal("image"),
  /** Local project asset, copied into the render workspace. */
  src: LocalAssetPath,
  caption: z.string().optional(),
});

export const DiagramStep = z.object({
  label: z.string().min(1),
  note: z.string().optional(),
});
export type DiagramStep = z.infer<typeof DiagramStep>;

export const DiagramScene = z.object({
  ...sceneBase,
  kind: z.literal("diagram"),
  heading: z.string().optional(),
  steps: z.array(DiagramStep).min(2).max(5),
  caption: z.string().optional(),
});

export const HtmlScene = z.object({
  ...sceneBase,
  kind: z.literal("html"),
  /**
   * Static HTML/CSS fragment rendered in a sandbox iframe. Without
   * `animation`, scripts are disabled and the layout must not depend on
   * scripts or CSS animations: frames are captured sequentially, so
   * wall-clock animation is not frame-deterministic.
   */
  html: z.string().min(1).max(1024 * 1024),
  /**
   * "gsap" opts the fragment into the frame-addressed GSAP runtime
   * (packages/video/src/scenes/html-runtime.ts): scripts run inside a
   * same-origin-blocked iframe, and Remotion seeks a paused timeline built by
   * `window.__glintTimeline = (gsap) => gsap.timeline({paused:true})...`
   * once per frame. Determinism red line: the fragment must not use
   * Date.now/Math.random/performance.now or CSS animations.
   */
  animation: z.enum(["gsap", "three", "lottie"]).optional(),
  background: z.string().min(1).optional(),
  caption: z.string().optional(),
});
export type HtmlScene = z.infer<typeof HtmlScene>;

// A nested model discriminator preserves a precise src requirement for glTF.
export const Scene = z.union([
  TitleScene,
  BulletsScene,
  DefinitionScene,
  QuoteScene,
  ComparisonScene,
  CodeScene,
  ThreeScene,
  ImageScene,
  DiagramScene,
  HtmlScene,
]);
export type Scene = z.infer<typeof Scene>;

export type TitleScene = z.infer<typeof TitleScene>;
export type BulletsScene = z.infer<typeof BulletsScene>;
export type DefinitionScene = z.infer<typeof DefinitionScene>;
export type QuoteScene = z.infer<typeof QuoteScene>;
export type ComparisonScene = z.infer<typeof ComparisonScene>;
export type CodeScene = z.infer<typeof CodeScene>;
export type ThreeScene = z.infer<typeof ThreeScene>;
export type ImageScene = z.infer<typeof ImageScene>;
export type DiagramScene = z.infer<typeof DiagramScene>;

export const KnowledgeSourceRef = z.object({
  id: kebabId,
  kind: z.literal("markdown"),
  name: z.string().min(1),
  digest: z.string().min(1).optional(),
});
export type KnowledgeSourceRef = z.infer<typeof KnowledgeSourceRef>;

export const BackgroundMusic = z.object({
  /** Static asset path inside the render workspace; loops under narration. */
  src: z.string().min(1),
  volume: z.number().min(0).max(1).optional(),
});
export type BackgroundMusic = z.infer<typeof BackgroundMusic>;

export const SceneScriptProject = z
  .object({
    schemaVersion: z.literal(SCENESCRIPT_VERSION, {
      errorMap: () => ({
        message: `schemaVersion must be ${SCENESCRIPT_VERSION}`,
      }),
    }),
    id: kebabId,
    title: z.string().min(1),
    language: z.string().min(2).optional(),
    aspect: AspectRatio,
    fps: z.number().int().min(24).max(60).optional(),
    knowledgeSources: z.array(KnowledgeSourceRef),
    music: BackgroundMusic.optional(),
    /** Theme name or inline design-token overrides. */
    theme: z
      .union([z.string().min(1), z.record(z.string(), z.unknown())])
      .optional(),
    scenes: z.array(Scene).min(1, "a project needs at least one scene"),
  })
  .superRefine((project, ctx) => {
    const sceneIds = new Set<string>();
    for (const [index, scene] of project.scenes.entries()) {
      if (sceneIds.has(scene.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scenes", index, "id"],
          message: `duplicate scene id "${scene.id}"`,
        });
      }
      sceneIds.add(scene.id);
    }
    const sourceIds = new Set<string>();
    for (const [index, source] of project.knowledgeSources.entries()) {
      if (sourceIds.has(source.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["knowledgeSources", index, "id"],
          message: `duplicate knowledge source id "${source.id}"`,
        });
      }
      sourceIds.add(source.id);
    }
  });
export type SceneScriptProject = z.infer<typeof SceneScriptProject>;
