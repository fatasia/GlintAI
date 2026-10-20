import { describe, expect, it } from "vitest";
import { MockLlmProvider } from "@glintai/llm";
import { parseProject } from "@glintai/scenescript";
import { defaultPersonas } from "./personas";
import { rehearse } from "./rehearse";
import { reexplain } from "./reexplain";

function tinyProject() {
  return parseProject({
    schemaVersion: 1,
    id: "demo",
    title: "熵",
    aspect: "16:9",
    language: "zh-CN",
    knowledgeSources: [],
    scenes: [
      { id: "intro", kind: "title", title: "熵", narration: { text: "聊聊熵。" } },
      {
        id: "define",
        kind: "definition",
        term: "熵",
        definition: "混乱度的度量",
        narration: { text: "熵衡量混乱程度。" },
      },
    ],
  });
}

describe("rehearse", () => {
  it("parses persona confusions and clamps unknown scene ids", async () => {
    const llm = new MockLlmProvider(() =>
      JSON.stringify([
        { sceneId: "define", confusion: "混乱度具体指什么?" },
        { sceneId: "不存在的场景", confusion: "这里跟不上了" },
      ]),
    );
    const [report] = await rehearse(tinyProject(), llm, {
      personas: defaultPersonas("zh-CN").slice(0, 1),
    });
    expect(report?.persona.id).toBe("curious-student");
    expect(report?.confusions[0]?.sceneId).toBe("define");
    // Hallucinated scene ids collapse to "general" instead of breaking the loop.
    expect(report?.confusions[1]?.sceneId).toBe("general");
  });

  it("keeps listening when a persona replies with prose instead of JSON", async () => {
    const llm = new MockLlmProvider(() => "我都听懂了,没啥问题。");
    const [report] = await rehearse(tinyProject(), llm, {
      personas: defaultPersonas("zh-CN").slice(0, 1),
    });
    expect(report?.confusions).toEqual([]);
  });
});

describe("reexplain", () => {
  it("invalidates old audio and timings while preserving voice and other scenes", async () => {
    const project = tinyProject();
    project.scenes[1]!.narration = { text: "Old", voice: "voice-a", speakingRate: 1.1, audioRef: "old.wav", durationMs: 1000, segments: [{ text: "Old", startMs: 0, endMs: 1000 }] };
    const llm = new MockLlmProvider(() => JSON.stringify({ ...project.scenes[1], narration: { ...project.scenes[1]!.narration, text: "New" } }));
    const updated = await reexplain(project, llm, { sceneId: "define" });
    expect(updated.scenes[0]).toBe(project.scenes[0]);
    expect(updated.scenes[1]!.narration).toEqual({ text: "New", voice: "voice-a", speakingRate: 1.1 });
    expect(project.scenes[1]!.narration.audioRef).toBe("old.wav");
  });
  it("rewrites exactly one scene, keeping id and kind", async () => {
    const rewritten = {
      id: "define",
      kind: "definition",
      term: "熵",
      definition: "把一间房间越弄越乱的可能性,就是熵。",
      narration: { text: "熵,就是房间越变越乱的那种趋势。" },
    };
    const llm = new MockLlmProvider(() => JSON.stringify(rewritten));
    const updated = await reexplain(tinyProject(), llm, {
      sceneId: "define",
      confusion: "混乱度太抽象",
    });
    expect(updated.scenes.length).toBe(2);
    expect(updated.scenes[1]?.id).toBe("define");
    if (updated.scenes[1]?.kind === "definition") {
      expect(updated.scenes[1].definition).toContain("房间");
    } else {
      throw new Error("kind changed");
    }
  });

  it("rejects unknown scene ids with the known list", async () => {
    const llm = new MockLlmProvider(() => "{}");
    await expect(
      reexplain(tinyProject(), llm, { sceneId: "nope" }),
    ).rejects.toThrow(/No scene with id "nope".*intro, define/s);
  });

  it("rejects a rewrite that changes scene identity", async () => {
    const llm = new MockLlmProvider(
      () =>
        JSON.stringify({
          id: "define",
          kind: "quote",
          text: "x",
          narration: { text: "y" },
        }),
    );
    await expect(
      reexplain(tinyProject(), llm, { sceneId: "define" }),
    ).rejects.toThrow(/scene identity/);
  });

  it("rejects structurally invalid rewrites with issue paths", async () => {
    const llm = new MockLlmProvider(() =>
      JSON.stringify({ id: "define", kind: "definition", term: "", definition: "x", narration: { text: "y" } }),
    );
    await expect(
      reexplain(tinyProject(), llm, { sceneId: "define" }),
    ).rejects.toThrow(/failed validation/);
  });
});
