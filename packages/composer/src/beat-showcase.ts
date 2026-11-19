import type { Scene } from "@glintai/scenescript";

export const SHOWCASE_BPM = 84;
export const SHOWCASE_FPS = 30;
export const SHOWCASE_BEATS = 24;

/** Quantize the global beat once, never round individual scene lengths. */
export function showcaseBeatMs(beat: number): number {
  return Math.round(Math.round(beat * 60 * SHOWCASE_FPS / SHOWCASE_BPM) * 1000 / SHOWCASE_FPS);
}

/** Plain editable scenes; no renderer, audio provider or runtime template remains. */
export function buildBeatShowcase(v: Record<string, string>): Scene[] {
  const scenes: Scene[] = [
    { id: "showcase-open", kind: "title", title: v.title!, subtitle: v.tagline!, narration: { text: v.title! } },
    { id: "showcase-product", kind: "bullets", heading: v.productName!, items: [v.feature1!, v.feature2!], narration: { text: `${v.feature1}。${v.feature2}` } },
    { id: "showcase-turn", kind: "title", title: v.statement!, narration: { text: v.statement! } },
    { id: "showcase-code", kind: "code", heading: v.codeHeading!, code: v.code!, language: "typescript", narration: { text: v.codeHeading! } },
    { id: "showcase-value", kind: "title", title: v.value!, subtitle: v.productName!, narration: { text: v.value! } },
    { id: "showcase-close", kind: "bullets", heading: v.cta!, items: [v.productName!, v.tagline!], narration: { text: v.cta! } },
  ];
  return scenes.map((scene, index) => {
    const start = showcaseBeatMs(index * 4);
    const durationMs = showcaseBeatMs((index + 1) * 4) - start;
    const beats = Array.from({ length: 4 }, (_, beat) => showcaseBeatMs(index * 4 + beat) - start);
    return {
      ...scene, narration: { ...scene.narration, durationMs },
      // A small editable beat marker, clear of the main type and caption regions.
      elements: [{ id: "beat-marker", kind: "text", text: `${String(index + 1).padStart(2, "0")} / 06`, x: 0.5, y: 0.12, fontSize: 24 }],
      tracks: [{ elementId: "beat-marker", property: "scale", keyframes: beats.flatMap(atMs => [
        { atMs, value: 1.12 }, { atMs: atMs + 200, value: 1, easing: "ease-out" as const },
      ]) }],
    };
  });
}
