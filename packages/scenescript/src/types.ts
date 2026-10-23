import { z } from "zod";
import { GltfAssetPath, LocalAssetPath } from "./assets";
import { SceneEffect } from "./effects";

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
  /** J/L cut: shift narration audio relative to the scene start (−5000..5000 ms). */
  audioOffsetMs: z.number().int().min(-5000).max(5000).optional(),
  voice: z.string().min(1).optional(),
  speakingRate: z.number().min(0.5).max(2).optional(),
  /** Static asset path inside the render workspace, set when audio exists. */
  audioRef: z.string().min(1).optional(),
  durationMs: z.number().int().positive().optional(),
  segments: z.array(NarrationSegment).optional(),
});
export type Narration = z.infer<typeof Narration>;

export const CameraMoveSpec = z.object({
  type: z.enum(["static", "push", "pull", "pan-left", "pan-right", "drift"]),
  /** 0..1, how far the move travels; defaults to 0.5. */
  intensity: z.number().min(0).max(1).optional(),
});
export type CameraMove = z.infer<typeof CameraMoveSpec>;

export const TransitionSpec = z.object({
  in: z.enum([
    "fade",
    "slide-left",
    "slide-right",
    "slide-up",
    "wipe",
    "zoom-punch",
    "iris",
    "blur",
    "flip",
    "flash",
    "magic-move",
  ]),
  durationMs: z.number().int().min(120).max(1200).optional(),
  /**
   * Cross-dissolve: this scene's entrance overlaps the previous scene by this
   * many milliseconds (100..1500). The timeline shortens accordingly for every
   * consumer (video backends, deck order, SRT), so narration stays in sync.
   * The previous scene stays visible underneath while this one fades in.
   */
  overlapMs: z.number().int().min(100).max(1500).optional(),
});
export type TransitionSpec = z.infer<typeof TransitionSpec>;

export const SharedElement = z.object({
  key: kebabId,
  text: z.string().min(1).max(200),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  fontSize: z.number().min(12).max(240).optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
});
export type SharedElement = z.infer<typeof SharedElement>;

export const AssetIdentity = z.object({
  id: kebabId,
  kind: z.enum(["character", "product", "brand", "location", "other"]),
  name: z.string().min(1).max(120),
  /** Bump when the look/identity changes; scenes pin an exact version. */
  version: z.string().min(1).max(40),
  /** Local asset files that define this identity (relative to the project). */
  refs: z.array(LocalAssetPath).max(50).optional(),
});
export type AssetIdentity = z.infer<typeof AssetIdentity>;

export const AssetRef = z.object({ assetId: kebabId, version: z.string().min(1).max(40) });
export type AssetRef = z.infer<typeof AssetRef>;

export const Easing = z.union([
  z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]),
  z.object({ bezier: z.tuple([z.number().min(0).max(1), z.number(), z.number().min(0).max(1), z.number()]) }),
]);
export type Easing = z.infer<typeof Easing>;

export const Keyframe = z.object({
  atMs: z.number().int().nonnegative().max(24 * 60 * 60 * 1000),
  value: z.number().finite(),
  /** Easing applied on the segment that ENDS at this keyframe. */
  easing: Easing.optional(),
});
export type Keyframe = z.infer<typeof Keyframe>;

export const AnimationProperty = z.enum(["x", "y", "opacity", "scale", "rotate"]);
export type AnimationProperty = z.infer<typeof AnimationProperty>;

export const AnimationTrack = z.object({
  elementId: kebabId,
  property: AnimationProperty,
  keyframes: z.array(Keyframe).min(1).max(64),
});
export type AnimationTrack = z.infer<typeof AnimationTrack>;

export const SceneElement = z.discriminatedUnion("kind", [
  z.object({
    id: kebabId,
    kind: z.literal("text"),
    text: z.string().min(1).max(500),
    /** Normalized canvas position, 0..1. */
    x: z.number().min(0).max(1).optional(),
    y: z.number().min(0).max(1).optional(),
    fontSize: z.number().min(12).max(240).optional(),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    weight: z.union([z.literal(400), z.literal(600), z.literal(700), z.literal(800)]).optional(),
    align: z.enum(["left", "center", "right"]).optional(),
  }),
  z.object({
    id: kebabId,
    kind: z.literal("rect"),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0.001).max(1),
    h: z.number().min(0.001).max(1),
    fill: z.string().regex(/^#[0-9a-f]{6}$/i),
    radius: z.number().min(0).max(64).optional(),
  }),
]);
export type SceneElement = z.infer<typeof SceneElement>;

export const UnderstandingQuiz = z.object({
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1).max(300)).min(2).max(6),
  answerIndex: z.number().int().nonnegative(),
  explanation: z.string().min(1).max(1000),
}).refine((quiz) => quiz.answerIndex < quiz.options.length, "answerIndex must reference an option");

const sceneBase = {
  id: kebabId,
  /** Locked scenes refuse trim/ripple/roll edits. */
  locked: z.boolean().optional(),
  narration: Narration,
  notes: z.string().max(10000).optional(),
  quiz: UnderstandingQuiz.optional(),
  sharedElements: z.array(SharedElement).max(20).optional(),
  /** Stable editable objects drawn above the scene content. */
  elements: z.array(SceneElement).max(20).optional(),
  /** Object animation tracks; sampled at frame time by both renderers. */
  tracks: z.array(AnimationTrack).max(40).optional(),
  /** Ordered whole-scene local effects, shared by preview and export. */
  effects: z.array(SceneEffect).max(16).refine(items => new Set(items.map(item => item.id)).size === items.length, "duplicate effect id").optional(),
  /** Identity versions this scene depends on; changing one invalidates only its scenes. */
  assetRefs: z.array(AssetRef).max(20).optional(),
  beatPulse: z.object({
    beatsMs: z.array(z.number().finite().nonnegative()).max(1000),
    amount: z.number().min(0).max(0.12).optional(),
    durationMs: z.number().int().min(80).max(800).optional(),
  }).optional(),
  /**
   * In-scene camera move over the whole scene (frame-derived transform in
   * packages/video motion.ts). "static" is the default and means no wrapper.
   */
  camera: CameraMoveSpec.optional(),
  /** Entrance transition applied to the scene content (captions stay stable). */
  transition: TransitionSpec.optional(),
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

export const SceneProvenance = z.object({
  origin: z.enum(["footage", "generated"]),
  /** Where the pixels came from (file path, prompt id, provider job id). */
  source: z.string().min(1).max(2000).optional(),
  model: z.string().min(1).max(200).optional(),
  seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
});
export type SceneProvenance = z.infer<typeof SceneProvenance>;

export const ImageScene = z.object({
  ...sceneBase,
  kind: z.literal("image"),
  /** Local project asset, copied into the render workspace. */
  src: LocalAssetPath,
  /** Declared source of the pixels; feeds L3 provenance in the receipt. */
  provenance: SceneProvenance.optional(),
  caption: z.string().optional(),
});

/**
 * Local video asset (gateway-generated clip or user file) played inside the
 * timeline. Scene length still follows narration; the clip starts at
 * `trimStartSec` and is cover-fit. Generation itself is a media-gateway job
 * and stays out of the render path.
 */

export const VideoScene = z.object({
  ...sceneBase,
  kind: z.literal("video"),
  src: LocalAssetPath,
  trimStartSec: z.number().min(0).optional(),
  trimEndSec: z.number().min(0).optional(),
  /** Playback speed of the source clip inside this scene; 1 = realtime. */
  speed: z.number().min(0.25).max(4).optional(),
  /** Declared source of the pixels; feeds L3 provenance in the receipt. */
  provenance: SceneProvenance.optional(),
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
export const ChartDataPoint = z.object({
  label: z.string().min(1).max(24),
  value: z.number().finite().min(-1e12).max(1e12),
  /** Second series: scatter Y (with value as X) or combo line (over value bars). */
  value2: z.number().finite().min(-1e12).max(1e12).optional(),
});
export type ChartDataPoint = z.infer<typeof ChartDataPoint>;

export const ChartScene = z
  .object({
    ...sceneBase,
    kind: z.literal("chart"),
    chartType: z.enum(["bar", "line", "pie", "area", "scatter", "combo"]),
    heading: z.string().optional(),
    unit: z.string().max(16).optional(),
    /** Label for the second series (combo line / scatter axis note). */
    seriesLabel2: z.string().max(16).optional(),
    data: z.array(ChartDataPoint).min(1).max(24),
  })
  .superRefine((scene, ctx) => {
    if ((scene.chartType === "scatter" || scene.chartType === "combo") &&
      scene.data.some((item) => item.value2 === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data"],
        message: `chartType "${scene.chartType}" needs value2 on every data point`,
      });
    }
  });
export type ChartScene = z.infer<typeof ChartScene>;

export const Scene = z.union([
  TitleScene,
  BulletsScene,
  DefinitionScene,
  QuoteScene,
  ComparisonScene,
  CodeScene,
  ThreeScene,
  ImageScene,
  VideoScene,
  DiagramScene,
  HtmlScene,
  ChartScene,
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
export type VideoScene = z.infer<typeof VideoScene>;
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

/** Sound effect presets synthesized offline (packages/music synth.ts). */
export const SfxEffect = z.enum(["impact", "whoosh", "sparkle", "click", "pop", "riser"]);
export type SfxEffect = z.infer<typeof SfxEffect>;

/**
 * A one-shot effect pinned to a narration word inside a scene. `word` is
 * matched against the narration word timings (prefix, case-insensitive);
 * without `word` the effect fires at the scene start.
 */
export const SfxCue = z.object({
  sceneId: kebabId,
  word: z.string().min(1).optional(),
  effect: SfxEffect,
  gain: z.number().min(0).max(1).optional(),
});
export type SfxCue = z.infer<typeof SfxCue>;

export const SceneScriptProject = z
  .object({
    schemaVersion: z.literal(SCENESCRIPT_VERSION, {
      errorMap: () => ({
        message: `schemaVersion must be ${SCENESCRIPT_VERSION}`,
      }),
    }),
    id: kebabId,
    title: z.string().min(1),
    /** Immutable origin pin; updating an installed creation pack never rewrites an existing project. */
    creationPack: z.object({ id: kebabId, version: z.string().regex(/^\d+\.\d+\.\d+$/) }).optional(),
    language: z.string().min(2).optional(),
    aspect: AspectRatio,
    /**
     * 24 / 25 / 30 / 50 / 60 as before, plus NTSC rates written as 23.976,
     * 29.97 or 59.94 (mapped to their exact rationals at render time).
     */
    fps: z.number().min(1).max(120).refine(value => Math.abs(Math.round(value * 1000) - value * 1000) < 1e-3, "fps supports at most three decimals").optional(),
    knowledgeSources: z.array(KnowledgeSourceRef),
    music: BackgroundMusic.optional(),
    sfx: z.array(SfxCue).optional(),
    /** Theme name or inline design-token overrides. */
    theme: z
      .union([z.string().min(1), z.record(z.string(), z.unknown())])
      .optional(),
    /** Character/product/brand identities shared across scenes (C13). */
    assets: z.array(AssetIdentity).max(200).optional(),
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
    for (const [sceneIndex, scene] of project.scenes.entries()) {
      const elementIds = new Set<string>();
      for (const [elementIndex, element] of (scene.elements ?? []).entries()) {
        if (elementIds.has(element.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scenes", sceneIndex, "elements", elementIndex, "id"], message: `duplicate element id "${element.id}"` });
        elementIds.add(element.id);
      }
      for (const [trackIndex, track] of (scene.tracks ?? []).entries()) {
        if (!elementIds.has(track.elementId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scenes", sceneIndex, "tracks", trackIndex, "elementId"], message: `track references unknown element "${track.elementId}"` });
        const seen = new Set<number>();
        for (const [keyIndex, key] of track.keyframes.entries()) {
          if (seen.has(key.atMs)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scenes", sceneIndex, "tracks", trackIndex, "keyframes", keyIndex, "atMs"], message: `duplicate keyframe time ${key.atMs}ms` });
          seen.add(key.atMs);
        }
      }
    }
    const assets = new Map((project.assets ?? []).map(asset => [asset.id, asset]));
    for (const [index, asset] of (project.assets ?? []).entries()) {
      if ((project.assets ?? []).filter(other => other.id === asset.id).length > 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assets", index, "id"], message: `duplicate asset id "${asset.id}"` });
      }
    }
    for (const [sceneIndex, scene] of project.scenes.entries()) {
      const seen = new Set<string>();
      for (const [refIndex, ref] of (scene.assetRefs ?? []).entries()) {
        if (seen.has(ref.assetId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scenes", sceneIndex, "assetRefs", refIndex, "assetId"], message: `duplicate asset reference "${ref.assetId}"` });
        seen.add(ref.assetId);
        const asset = assets.get(ref.assetId);
        if (!asset) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scenes", sceneIndex, "assetRefs", refIndex, "assetId"], message: `unknown asset "${ref.assetId}"` });
        else if (asset.version !== ref.version) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scenes", sceneIndex, "assetRefs", refIndex, "version"], message: `asset "${ref.assetId}" is at version ${asset.version}, scene pins ${ref.version}` });
      }
    }
  });
export type SceneScriptProject = z.infer<typeof SceneScriptProject>;