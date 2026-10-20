import { describe, expect, it } from "vitest";
import {
  HtmlScene as HtmlSceneSchema,
  MIN_SCENE_DURATION_MS,
  SceneScriptParseError,
  buildTimeline,
  estimateNarrationDurationMs,
  estimateWordTimings,
  parseProject,
  sceneDurationMs,
  safeParseProject,
  timelineToFrames,
} from "./index";

function baseProject(overrides?: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    id: "demo",
    title: "Demo",
    aspect: "16:9",
    knowledgeSources: [],
    scenes: [
      {
        id: "intro",
        kind: "title",
        title: "熵与生命",
        narration: { text: "今天我们聊一个词：熵。" },
      },
    ],
    ...overrides,
  };
}

describe("parseProject", () => {
  it("accepts a minimal valid project", () => {
    const project = parseProject(baseProject());
    expect(project.scenes[0]?.kind).toBe("title");
    expect(project.aspect).toBe("16:9");
  });

  it("rejects an unknown scene kind with a useful path", () => {
    const result = safeParseProject(
      baseProject({
        scenes: [{ id: "weird", kind: "hologram", narration: { text: "x" } }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join("\n")).toContain("scenes.0");
    }
  });

  it("rejects duplicate scene ids", () => {
    const scene = {
      id: "intro",
      kind: "title",
      title: "A",
      narration: { text: "x" },
    };
    const result = safeParseProject(baseProject({ scenes: [scene, scene] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join("\n")).toContain('duplicate scene id "intro"');
    }
  });

  it("rejects empty scenes and empty narration", () => {
    const emptyScenes = safeParseProject(baseProject({ scenes: [] }));
    expect(emptyScenes.ok).toBe(false);

    const emptyNarration = safeParseProject(
      baseProject({
        scenes: [{ id: "a", kind: "title", title: "t", narration: { text: "" } }],
      }),
    );
    expect(emptyNarration.ok).toBe(false);
  });

  it("rejects wrong schemaVersion and non-kebab ids", () => {
    expect(safeParseProject(baseProject({ schemaVersion: 2 })).ok).toBe(false);
    expect(
      safeParseProject(baseProject({ id: "Big Project" })).ok,
    ).toBe(false);
  });

  it("parseProject throws a SceneScriptParseError listing issues", () => {
    expect(() => parseProject({ nope: true })).toThrow(SceneScriptParseError);
  });
});

describe("estimateNarrationDurationMs", () => {
  it("scales with CJK text weight (4.6 chars/s)", () => {
    // 46 CJK chars → 10s
    const text = "熵".repeat(46);
    expect(estimateNarrationDurationMs(text)).toBe(10000);
  });

  it("speakingRate 2 halves the estimate, 0.5 doubles it", () => {
    const text = "熵".repeat(46);
    expect(estimateNarrationDurationMs(text, { speakingRate: 2 })).toBe(5000);
    expect(estimateNarrationDurationMs(text, { speakingRate: 0.5 })).toBe(20000);
  });

  it("clamps tiny text to the scene minimum", () => {
    expect(estimateNarrationDurationMs("熵")).toBe(MIN_SCENE_DURATION_MS);
  });

  it("throws on empty text", () => {
    expect(() => estimateNarrationDurationMs("   ")).toThrow(/empty/);
  });

  it("counts latin words by weight, not raw chars", () => {
    // "hello world" = 11 chars * 0.55 ≈ 1.2s at rate 1
    const ms = estimateNarrationDurationMs("hello world");
    expect(ms).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(1500);
  });

  it("paces hangul at CJK weight so Korean narrations get sane durations", () => {
    const hangul = estimateNarrationDurationMs("한국어");
    const han = estimateNarrationDurationMs("中国话");
    expect(hangul).toBe(han);
  });
});

describe("estimateWordTimings", () => {
  it("produces gap-free monotonic timings ending exactly at durationMs", () => {
    const words = estimateWordTimings("热力学第二定律说明一切", 5000);
    expect(words.length).toBeGreaterThan(0);
    expect(words[0]?.startMs).toBe(0);
    for (let i = 1; i < words.length; i++) {
      expect(words[i]?.startMs).toBe(words[i - 1]?.endMs);
    }
    expect(words[words.length - 1]?.endMs).toBe(5000);
    for (const word of words) {
      expect(word.endMs).toBeGreaterThan(word.startMs);
    }
  });

  it("returns empty for empty input or zero duration", () => {
    expect(estimateWordTimings("", 1000)).toEqual([]);
    expect(estimateWordTimings("熵", 0)).toEqual([]);
  });

  it("handles a single-token text", () => {
    const words = estimateWordTimings("熵", 800);
    expect(words).toEqual([{ text: "熵", startMs: 0, endMs: 800 }]);
  });
});

describe("timeline", () => {
  it("accumulates scene durations sequentially", () => {
    const project = parseProject(
      baseProject({
        scenes: [
          {
            id: "a",
            kind: "title",
            title: "A",
            narration: { text: "熵", durationMs: 2000 },
          },
          {
            id: "b",
            kind: "definition",
            term: "熵",
            definition: "混乱的度量",
            narration: { text: "熵", durationMs: 3000 },
          },
        ],
      }),
    );
    const timeline = buildTimeline(project);
    expect(timeline.entries.map((e) => e.startMs)).toEqual([0, 2000]);
    expect(timeline.totalMs).toBe(5000);
  });

  it("falls back to text estimates when durationMs is absent", () => {
    const project = parseProject(baseProject());
    expect(sceneDurationMs(project.scenes[0]!)).toBe(
      estimateNarrationDurationMs("今天我们聊一个词：熵。"),
    );
  });

  it("frame conversion never drifts and always fills totalFrames", () => {
    const project = parseProject(
      baseProject({
        scenes: [
          {
            id: "a",
            kind: "title",
            title: "A",
            narration: { text: "熵熵熵熵熵熵熵熵熵熵", durationMs: 1001 },
          },
          {
            id: "b",
            kind: "title",
            title: "B",
            narration: { text: "熵熵熵熵熵熵熵熵熵熵", durationMs: 999 },
          },
        ],
      }),
    );
    const timeline = buildTimeline(project);
    const fps = 30;
    const { entries, durationInFrames } = timelineToFrames(timeline, fps);
    expect(durationInFrames).toBe(Math.round((2000 / 1000) * fps));
    const last = entries[entries.length - 1];
    expect(last).toBeDefined();
    if (last) expect(last.from + last.duration).toBe(durationInFrames);
    expect(entries[0]?.from).toBe(0);
  });
});

describe("html scene animation option", () => {
  function htmlScene(overrides?: Record<string, unknown>) {
    return {
      id: "free-layout",
      kind: "html",
      html: "<div>layout</div>",
      narration: { text: "x" },
      ...overrides,
    };
  }
  it("accepts animation:\"gsap\" and round-trips", () => {
    const project = parseProject(baseProject({ scenes: [htmlScene({ animation: "gsap" })] }));
    expect(project.scenes[0]).toMatchObject({ animation: "gsap" });
    expect(parseProject(project)).toEqual(project);
  });
  it("keeps static html scenes valid without animation", () => {
    const [scene] = parseProject(baseProject({ scenes: [htmlScene()] })).scenes;
    expect(scene?.kind).toBe("html");
    if (scene?.kind === "html") expect(scene.animation).toBeUndefined();
  });
  it("rejects unknown animation engines with a useful path", () => {
    // The project-level union collapses member errors, so assert the enum on
    // the HtmlScene schema directly, plus the union path end-to-end.
    const invalid = HtmlSceneSchema.safeParse({
      id: "free-layout",
      kind: "html",
      html: "<div/>",
      animation: "framer",
      narration: { text: "x" },
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      const flat = invalid.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n");
      expect(flat).toContain("animation");
    }
    const result = safeParseProject(
      baseProject({ scenes: [htmlScene({ animation: "framer" })] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join("\n")).toContain("scenes.0");
    }
  });
});
