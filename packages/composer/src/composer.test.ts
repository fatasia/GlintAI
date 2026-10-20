import { describe, expect, it } from "vitest";
import { MockLlmProvider } from "@glintai/llm";
import { ComposerError, composeFromMarkdown } from "./heuristic";
import { composeWithLlm } from "./llm";

const ZH_SOURCE = [
  "# 不确定性原理",
  "",
  "在海森堡提出的不确定性原理中,粒子的位置与动量无法同时被精确确定。",
  "",
  "## 核心含义",
  "",
  "测量位置越精确,动量就越模糊。这不是仪器不够好,而是自然界的内禀属性。它源于物质的波动性。",
  "",
  "- 位置越确定,动量越不确定",
  "- 乘积存在下限普朗克常数的一半",
  "",
  "## 名言",
  "",
  "“自然不可约化,只可逼近。”",
  "— 狄拉克",
].join("\n");

const EN_SOURCE = [
  "# Compound Interest",
  "",
  "Compound interest means your money earns interest on its interest.",
  "",
  "## The Rule of 72",
  "",
  "Divide 72 by your annual return rate. The result approximates the years needed to double your money. It is a mental math shortcut.",
].join("\n");

describe("composeFromMarkdown (heuristic, offline)", () => {
  it("composes a valid zh project wired to its knowledge source", () => {
    const project = composeFromMarkdown(ZH_SOURCE, { projectId: "uncertainty" });
    expect(project.id).toBe("uncertainty");
    expect(project.language).toBe("zh-CN");
    expect(project.title).toBe("不确定性原理");
    expect(project.knowledgeSources).toEqual([
      { id: "source", kind: "markdown", name: "source.md" },
    ]);
    const kinds = project.scenes.map((scene) => scene.kind);
    expect(kinds[0]).toBe("title");
    expect(kinds).toContain("bullets");
    expect(kinds).toContain("quote");
    const quote = project.scenes.find((scene) => scene.kind === "quote");
    if (quote?.kind === "quote") {
      expect(quote.attribution).toBe("狄拉克");
    } else {
      throw new Error("quote scene missing");
    }
  });

  it("composes an en project with detected language", () => {
    const project = composeFromMarkdown(EN_SOURCE, { projectId: "interest" });
    expect(project.language).toBe("en-US");
    expect(project.scenes.length).toBeGreaterThanOrEqual(2);
    const first = project.scenes[1];
    expect(first).toBeDefined();
  });

  it("is deterministic: same input, byte-identical output", () => {
    const a = composeFromMarkdown(ZH_SOURCE);
    const b = composeFromMarkdown(ZH_SOURCE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("keeps narration within the pacing budget", () => {
    const project = composeFromMarkdown(ZH_SOURCE);
    for (const scene of project.scenes) {
      expect(scene.narration.text.length).toBeLessThanOrEqual(120);
    }
  });

  it("rejects an empty document with an actionable error", () => {
    expect(() => composeFromMarkdown("   ")).toThrow(ComposerError);
    expect(() => composeFromMarkdown("")).toThrow(/nothing to compose/i);
  });

  it("respects maxScenes", () => {
    const longDoc = Array.from({ length: 12 }, (_, i) => `## Section ${i}\n\n内容${i}。`).join("\n\n");
    const project = composeFromMarkdown(`# T\n\n${longDoc}`, { maxScenes: 5 });
    expect(project.scenes.length).toBe(5);
  });

  it("still composes a document without any headings", () => {
    const project = composeFromMarkdown("熵是混乱度的度量。生命以负熵为食。");
    expect(project.scenes[0]?.kind).toBe("title");
  });
});

describe("composeWithLlm", () => {
  const VALID_JSON = JSON.stringify({
    schemaVersion: 1,
    id: "llm-out",
    title: "熵",
    aspect: "16:9",
    scenes: [
      {
        id: "intro",
        kind: "title",
        title: "熵",
        narration: { text: "聊聊熵。" },
      },
    ],
  });

  it("parses a valid model reply into a project", async () => {
    const project = await composeWithLlm(
      ZH_SOURCE,
      new MockLlmProvider(() => VALID_JSON),
      { projectId: "from-llm" },
    );
    expect(project.id).toBe("from-llm");
    expect(project.scenes[0]?.kind).toBe("title");
  });

  it("tolerates code fences around the JSON", async () => {
    const fenced = "```json\n" + VALID_JSON + "\n```";
    const project = await composeWithLlm(ZH_SOURCE, new MockLlmProvider(() => fenced));
    expect(project.title).toBe("熵");
  });

  it("rejects prose-only replies with an actionable error", async () => {
    await expect(
      composeWithLlm(ZH_SOURCE, new MockLlmProvider(() => "这是一个很棒的主题！")),
    ).rejects.toThrow(/did not return a JSON object/);
  });

  it("rejects structurally invalid scenes with validation details", async () => {
    const broken = JSON.stringify({
      schemaVersion: 1,
      id: "x",
      title: "t",
      aspect: "16:9",
      scenes: [{ id: "a", kind: "hologram" }],
    });
    await expect(
      composeWithLlm(ZH_SOURCE, new MockLlmProvider(() => broken)),
    ).rejects.toThrow(/SceneScript validation/);
  });

  it("rejects an empty source before calling the model", async () => {
    let calls = 0;
    const llm = new MockLlmProvider(() => {
      calls += 1;
      return VALID_JSON;
    });
    await expect(composeWithLlm("  ", llm)).rejects.toThrow(/empty/i);
    expect(calls).toBe(0);
  });
});
