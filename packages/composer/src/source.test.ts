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
