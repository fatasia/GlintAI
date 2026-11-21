import type { SceneScriptProject } from "@glintai/scenescript";
import { parseProject } from "@glintai/scenescript";
import { describe, expect, it } from "vitest";
import { ComposerError } from "./errors";
import { briefFromSceneScript, MotionBrief, parseMotionBrief, renderMotionBrief } from "./motion-brief";

// Fixture: OpenMotion docs/motion-md.md portal profile (Apache-2.0), verbatim.
const PORTAL_EXAMPLE = `# Portal launch — MOTION_DESIGN.md
Version: 0.1.0
Source: pin the actual implementation and reference video here.

## Keep
Light card → expanding portal → dimensional phrase → white exit.
Keep the camera path, reveal timing, deterministic seed and easing.

## Replace
Title: OPENMOTION (maximum 18 characters in this profile).
Dimensional phrase: TELL YOUR STORY.
Subtitle: YOUR STORY. IN MOTION.

## Timing
0–0.45 s: card entrance. 0.45–2.5 s: portal reveal.
2.5–6 s: dimensional phrase. 6–8 s: push through and white exit.

## Materials and sound
Use the supplied Geist fonts and code. This example is silent.
A voice or music request is a separate input and timing decision.

## Review
Compare the card, portal handoff and phrase hold at matching times.
Check the whole phrase, camera continuity and text collisions.
Save source/preset hashes and actual output; record remaining gaps.`;

// Second fixture: real catalog entry library/templates/catalog/motion-0053d84c… (Apache-2.0).
const CATALOG_DEMO = `{
  "id": "sequence",
  "title": "整体编排",
  "src": "demos/sequence.html",
  "duration": 25.125,
  "status": "authored",
  "description": "动作与构图示意",
  "initialTime": 12,
  "params": [
    { "key": "title", "label": "示例主文案", "type": "text", "value": "OMARCHY × NOUS", "maxLength": 60 },
    { "key": "accent", "label": "强调色", "type": "color", "value": "#93b47b" }
  ],
  "presets": [
    { "label": "默认内容", "values": { "title": "OMARCHY × NOUS", "accent": "#93b47b" } },
    { "label": "OpenDesign 改编", "values": { "title": "OpenDesign", "accent": "#7050da" } }
  ]
}`;

/** Portal prose profile + one ```motion-demo block (catalog form): the full brief fixture. */
const PORTAL_BRIEF = `${PORTAL_EXAMPLE}

\`\`\`motion-demo
${CATALOG_DEMO}
\`\`\``;

function briefWithError(text: string): string {
  try {
    parseMotionBrief(text);
  } catch (error) {
    expect(error).toBeInstanceOf(ComposerError);
    return (error as ComposerError).message;
  }
  throw new Error("expected parseMotionBrief to throw");
}

describe("parseMotionBrief: OpenMotion portal profile", () => {
  const brief = parseMotionBrief(PORTAL_BRIEF);

  it("extracts title, source note and default kind from the portal prose", () => {
    expect(brief.title).toBe("Portal launch — MOTION_DESIGN.md");
    expect(brief.kind).toBe("video");
    expect(brief.source).toEqual({ note: "pin the actual implementation and reference video here." });
    expect(brief.id).toBe("sequence");
  });

  it("keeps every Keep line as one invariant", () => {
    expect(brief.keep).toHaveLength(2);
    expect(brief.keep[0]).toContain("expanding portal");
  });

  it("parses portal Replace lines (prose colon form) with hard-limit parentheses", () => {
    expect(brief.replace).toHaveLength(3);
    expect(brief.replace[0]).toEqual({ target: "Title", with: "OPENMOTION", hardLimits: ["maximum 18 characters in this profile"] });
    expect(brief.replace[1]).toEqual({ target: "Dimensional phrase", with: "TELL YOUR STORY." });
    expect(brief.replace[2]).toEqual({ target: "Subtitle", with: "YOUR STORY. IN MOTION." });
  });

  it("parses portal prose timing beats into ms rows", () => {
    expect(brief.timing).toEqual([
      { shot: "card entrance", startMs: 0, durationMs: 450 },
      { shot: "portal reveal", startMs: 450, durationMs: 2050 },
      { shot: "dimensional phrase", startMs: 2500, durationMs: 3500 },
      { shot: "push through and white exit", startMs: 6000, durationMs: 2000 },
    ]);
  });

  it("collects materials and prose review notes", () => {
    expect(brief.materials).toHaveLength(2);
    expect(brief.review.compareAt).toEqual([]);
    expect(brief.review.notes).toContain("Compare the card, portal handoff and phrase hold at matching times.");
    expect(brief.review.notes).toContain("record remaining gaps");
  });

  it("carries motion-demo params and presets unchanged (catalog form)", () => {
    expect(brief.params).toHaveLength(2);
    expect(brief.params[0]).toEqual({ key: "title", label: "示例主文案", type: "text", value: "OMARCHY × NOUS", maxLength: 60 });
    expect(brief.params[1]).toEqual({ key: "accent", label: "强调色", type: "color", value: "#93b47b" });
    expect(brief.presets).toHaveLength(2);
    expect(brief.presets[1]?.values).toEqual({ title: "OpenDesign", accent: "#7050da" });
  });
});

describe("parseMotionBrief ↔ renderMotionBrief round-trip", () => {
  it("round-trips the portal fixture losslessly", () => {
    const brief = parseMotionBrief(PORTAL_BRIEF);
    expect(parseMotionBrief(renderMotionBrief(brief))).toEqual(brief);
  });

  it("renders the canonical OpenMotion markdown shape (writable, diff-able)", () => {
    const brief = parseMotionBrief(PORTAL_BRIEF);
    const text = renderMotionBrief(brief);
    expect(text).toContain("## Keep");
    expect(text).toContain("## Replace");
    expect(text).toContain("- Title → OPENMOTION (限制: maximum 18 characters in this profile)");
    expect(text).toContain("| 0.00s–0.45s | card entrance |  |");
    expect(text).toContain("| 2.50s–6.00s | dimensional phrase |  |");
    expect(text).toContain("```motion-demo");
    expect(text).toContain(`"id": "sequence"`);
    expect(parseMotionBrief(text).id).toBe("sequence");
  });

  it("round-trips table timing, transitions, brand and materials sections", () => {
    const brief = MotionBrief.parse({
      id: "launch", title: "产品发布", kind: "page",
      source: { url: "https://example.com/ref", note: "参考片 15s 版本" },
      keep: ["白底黑字的进场"], replace: [{ target: "标题", with: "新品名称", hardLimits: ["≤ 12 字；不做斜体"] }],
      timing: [
        { shot: "开场", startMs: 0, durationMs: 1000, transition: "iris" },
        { shot: "产品亮相", startMs: 1000, durationMs: 250 },
        { shot: "落版", startMs: 1250, durationMs: 8750 },
      ],
      materials: ["Geist 字体", "无音轨"],
      review: { compareAt: ["0.5s: 首帧", "10s: 落版留读"], notes: "逐帧对比转场" },
      brand: { accent: "#7050da", bg: "#000000", text: "#e0ead7", displayFont: "Geist Mono" },
      params: [{ key: "headline", label: "主标题", type: "number", value: "42" }],
      presets: [{ label: "默认", values: { headline: "42" } }],
    });
    expect(parseMotionBrief(renderMotionBrief(brief))).toEqual(brief);
  });

  it("rejects a preset that references an undefined param", () => {
    const brief = MotionBrief.parse({ id: "x", title: "t", keep: [], replace: [], timing: [{ shot: "s", startMs: 0, durationMs: 1 }], review: { compareAt: [] }, params: [], presets: [{ label: "坏", values: { ghost: "1" } }] });
    expect(briefWithError(renderMotionBrief(brief))).toContain("引用了未定义的参数 ghost");
  });
});

describe("parseMotionBrief: malformed input raises zh-CN ComposerError", () => {
  it("requires a motion-demo block (plain portal example)", () => {
    expect(briefWithError(PORTAL_EXAMPLE)).toContain("缺少 motion-demo 代码块");
  });
  it("requires an H1 title", () => {
    expect(briefWithError(PORTAL_BRIEF.replace(/^# .*\n/m, ""))).toContain("缺少一级标题");
  });
  it("rejects invalid motion-demo JSON", () => {
    expect(briefWithError(PORTAL_BRIEF.replace(/\{[\s\S]*\}/, "{ broken")).replace).toBeTruthy;
    expect(briefWithError(PORTAL_BRIEF.replace(/\{[\s\S]*\}/, "{ broken"))).toContain("不是合法 JSON");
  });
  it("requires the four sections", () => {
    expect(briefWithError(PORTAL_BRIEF.replace("## Timing", "## Tempo"))).toContain("缺少 ## Timing 小节");
    expect(briefWithError(PORTAL_BRIEF.replace("## Keep", "## 保留"))).toContain("缺少 ## Keep 小节");
  });
  it("rejects an unknown Kind", () => {
    expect(briefWithError(`${PORTAL_BRIEF.replace("Source: pin the actual implementation and reference video here.", "Kind: movie")}`)).toContain("Kind 取值不合法");
  });
  it("rejects a reversed timing range", () => {
    expect(briefWithError(PORTAL_BRIEF.replace("0.45–2.5 s", "2.5–0.45 s"))).toContain("时间区间不合法");
  });
  it("rejects a Replace line with neither arrow nor colon", () => {
    expect(briefWithError(PORTAL_BRIEF.replace("Subtitle: YOUR STORY. IN MOTION.", "Subtitle 只换文案"))).toContain("「目标 → 替换」");
  });
  it("surfaces zod issues (duplicate key, bad color, maxLength overflow) in zh-CN", () => {
    const base = {
      id: "x", title: "t", keep: [], replace: [],
      timing: [{ shot: "s", startMs: 0, durationMs: 1 }], review: { compareAt: [] },
    };
    expect(briefWithError(renderMotionBrief(MotionBrief.parse({
      ...base, params: [
        { key: "a", label: "甲", type: "text", value: "1" },
        { key: "a", label: "乙", type: "color", value: "red" },
      ], presets: [],
    })))).toContain("参数 key 重复：a");
    expect(briefWithError(renderMotionBrief(MotionBrief.parse({
      ...base, params: [{ key: "c", label: "色", type: "color", value: "#12345" }], presets: [],
    })))).toContain("#RRGGBB");
    expect(briefWithError(renderMotionBrief(MotionBrief.parse({
      ...base, params: [{ key: "n", label: "字", type: "text", value: "太长了", maxLength: 2 }], presets: [],
    })))).toContain("超过 maxLength 2");
  });
});

describe("briefFromSceneScript: SceneScript 工程 → OpenMotion 同形制简报", () => {
  const project = parseProject({
    schemaVersion: 1,
    id: "entropy-lecture",
    title: "熵与生命",
    aspect: "16:9",
    fps: 30,
    knowledgeSources: [],
    scenes: [
      {
        id: "opening", kind: "title", title: "熵与生命",
        narration: { text: "为什么生命逆着熵的方向生长。", durationMs: 3000 },
        transition: { in: "zoom-punch", durationMs: 600 },
        elements: [{ id: "kicker", kind: "text", text: "热力学第二讲" }],
      },
      {
        id: "evidence", kind: "bullets", heading: "三条证据",
        items: ["能量流动", "复制机制", "变异选择"],
        narration: { text: "三条证据支持这个观点。", durationMs: 4000 },
      },
      {
        id: "chart", kind: "chart", chartType: "bar", heading: "宇宙熵增曲线",
        data: [{ label: "起点", value: 1 }, { label: "现在", value: 3 }],
        narration: { text: "宇宙整体熵仍在增加。", durationMs: 3000 },
        transition: { in: "fade", overlapMs: 500 },
      },
    ],
  }) as SceneScriptProject;

  const brief = briefFromSceneScript(project);

  it("maps the built timeline (cross-dissolve overlap included) onto the Timing table", () => {
    expect(brief.timing).toEqual([
      { shot: "熵与生命", startMs: 0, durationMs: 3000, transition: "zoom-punch" },
      { shot: "三条证据", startMs: 3000, durationMs: 4000 },
      { shot: "宇宙熵增曲线", startMs: 6500, durationMs: 3000, transition: "fade" },
    ]);
    expect(parseMotionBrief(renderMotionBrief(brief)).timing).toEqual(brief.timing);
  });

  it("drafts Replace prompts from scene text objects with blank targets to fill", () => {
    const targets = brief.replace.map(item => item.target);
    expect(targets).toContain("热力学第二讲");
    expect(targets).toContain("熵与生命");
    expect(targets).toContain("能量流动");
    expect(targets).toContain("变异选择");
    expect(brief.replace.every(item => item.with === "")).toBe(true);
  });

  it("keeps project identity, aspect and review anchors; materials stay absent", () => {
    expect(brief.id).toBe("entropy-lecture");
    expect(brief.title).toBe("熵与生命");
    expect(brief.kind).toBe("video");
    expect(brief.keep[0]).toContain("3 个镜头");
    expect(brief.keep[1]).toContain("16:9");
    expect(brief.keep[1]).toContain("30 fps");
    expect(brief.review.compareAt).toHaveLength(2);
    expect(brief.review.compareAt[1]).toContain("9.50s");
    expect(brief.materials).toBeUndefined();
    expect(brief.params).toEqual([]);
    expect(brief.presets).toEqual([]);
  });

  it("lists music and asset identities as materials when present", () => {
    const withMusic = briefFromSceneScript(parseProject({
      ...JSON.parse(JSON.stringify(project)),
      music: { src: "assets/loop.mp3", volume: 0.4 },
      assets: [{ id: "hero", kind: "character", name: "小熵", version: "v3" }],
    }));
    expect(withMusic.materials).toEqual(["背景音乐：assets/loop.mp3", "身份素材（character）：小熵"]);
  });

  it("estimates narration duration when the scene has none", () => {
    const noDuration = briefFromSceneScript(parseProject({
      schemaVersion: 1, id: "one-shot", title: "单镜", aspect: "9:16",
      knowledgeSources: [],
      scenes: [{ id: "only", kind: "quote", text: "简约至极。", narration: { text: "一句话讲完。" } }],
    }));
    expect(noDuration.timing).toHaveLength(1);
    expect(noDuration.timing[0]?.startMs).toBe(0);
    expect((noDuration.timing[0]?.durationMs ?? 0)).toBeGreaterThan(0);
  });
});
