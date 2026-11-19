import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { composeFromSource } from "./source";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe("compose source integration without keys or network", () => {
  it.each([
    ["md", "# 标题\n\n## 概念\n\n内容。"],
    ["txt", "# 标题\n\n内容。"],
    ["html", "<h1>标题</h1><p>内容。</p>"],
    ["json", '{"标题":"内容"}'],
    ["csv", '主题,内容\n标题,解释'],
  ])("composes %s with the actual source name", async (ext, body) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint composer 中文 "));
    dirs.push(dir);
    const file = path.join(dir, `source name.${ext}`);
    await fs.writeFile(file, body);
    const result = await composeFromSource({ path: file }, undefined, { projectId: "offline" });
    expect(result.project.scenes.length).toBeGreaterThan(0);
    expect(result.sourceText).toBeTruthy();
    expect(result.sourceName).toBe(`source name.${ext}`);
    expect(result.project.knowledgeSources?.[0]?.name).toBe(`source name.${ext}`);
    expect(result.project.scenes.every(scene => scene.camera?.type === "drift" || ["html", "three"].includes(scene.kind))).toBe(true);
  });
  it("rejects multiple/blank sources before any model work", async () => {
    await expect(composeFromSource({ path: "a", idea: "b" }, undefined)).rejects.toThrow("exactly one");
    await expect(composeFromSource({ path: " " }, undefined)).rejects.toThrow("blank");
    await expect(composeFromSource({}, undefined)).rejects.toThrow("exactly one");
  });
  it("rejects idea without a provider, unsafe URLs and invalid scene limits", async () => {
    await expect(composeFromSource({ idea: "topic" }, undefined)).rejects.toThrow("needs an LLM");
    await expect(composeFromSource({ url: "http://127.0.0.1" }, undefined)).rejects.toThrow("Private");
    await expect(composeFromSource({ path: "unused" }, undefined, { maxScenes: NaN })).rejects.toThrow("maxScenes");
  });
});

describe("source-fact provenance end to end (CREATE-14)", () => {
  it("propagates the audited source through provenance, audit trail and review candidates", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint provenance "));
    dirs.push(dir);
    const file = path.join(dir, "咖啡店资料.md");
    const body = "# 咖啡店\n\n手冲咖啡需要 92 度水温。\n\n南山路 22 号周六开业。\n";
    await fs.writeFile(file, body);
    const { project, sourceText, sourceName } = await composeFromSource({ path: file }, undefined, { projectId: "provenance" });
    // Provenance points at the real file, the audit trail keeps the full text.
    expect(project.knowledgeSources).toEqual([{ id: "source", kind: "markdown", name: "咖啡店资料.md" }]);
    expect(sourceName).toBe("咖啡店资料.md");
    expect(sourceText).toBe(body);
    // A drifted number in narration is flagged against the source sentence.
    const drifted = JSON.parse(JSON.stringify(project));
    const target = drifted.scenes.find((scene: { narration: { text: string } }) => scene.narration.text.includes("手冲")) ?? drifted.scenes[0];
    target.narration.text = "手冲咖啡需要 300 度水温。";
    const { reviewProject } = await import("./quality");
    const report = reviewProject(drifted, sourceText);
    const flagged = report.sentences.filter(sentence => sentence.flags.includes("number-mismatch"));
    expect(flagged.length).toBeGreaterThan(0);
    expect(sourceText.slice(flagged[0]!.candidates[0]!.start, flagged[0]!.candidates[0]!.end)).toContain("92 度");
  });
  it("never trusts model-attached citations; the app owns provenance", async () => {
    const { composeWithLlm } = await import("./llm");
    const { MockLlmProvider } = await import("@glintai/llm");
    const reply = JSON.stringify({
      schemaVersion: 1, id: "fake-citations", title: "标题", aspect: "16:9",
      knowledgeSources: [{ id: "model-invented", kind: "markdown", name: "https://模型编造.example/来源" }],
      scenes: [{ id: "intro", kind: "title", title: "标题", narration: { text: "来源里确实写了的句子。" } }],
    });
    const project = await composeWithLlm("# 真实来源\n\n来源里确实写了的句子。", new MockLlmProvider(() => reply), { sourceName: "真实来源.md" });
    expect(project.knowledgeSources).toEqual([{ id: "source", kind: "markdown", name: "真实来源.md" }]);
  });
});
