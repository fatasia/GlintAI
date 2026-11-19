// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mockLlm } from "@glintai/llm";
import { writeClipCopy } from "./clip-copy";

const MANIFEST = {
  source: { videoPath: "long.mp4", durationMs: 40_000 },
  clips: [
    { id: "clip-01", startMs: 0, endMs: 18_000, motionScore: 600, shotCount: 2, file: "assets/clip-01.mp4", projectFile: "clip-01.project.json", coverFile: "assets/clip-01.jpg" },
    { id: "clip-02", startMs: 18_000, endMs: 33_000, motionScore: 210, shotCount: 1, file: "assets/clip-02.mp4", projectFile: "clip-02.project.json", coverFile: "assets/clip-02.jpg" },
  ],
};
const REPLY = JSON.stringify({ clips: [
  { id: "clip-01", title: "开场 18 秒", hook: "第一眼抓住节奏", caption: "长片开场，双镜头高运动度。" },
  { id: "clip-02", title: "收束段", hook: "稳住最后一口气", caption: "单镜头低运动，适合落版。" },
] });

describe("S06 clip copy", () => {
  let dir = "";
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ""; });

  it("fills the manifest copy field and validates model ids against it", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clipcopy-"));
    const manifestFile = path.join(dir, "clips.json");
    fs.writeFileSync(manifestFile, JSON.stringify(MANIFEST));
    const llm = mockLlm(REPLY);
    const { copies } = await writeClipCopy({ manifestFile, llm });
    expect(copies).toHaveLength(2);
    expect(copies[0]).toMatchObject({ id: "clip-01", title: "开场 18 秒" });
    const written = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    expect(written.copy[1]!.caption).toContain("落版");
    // Clips keep their payload; only copy is added.
    expect(written.clips[0]!.startMs).toBe(0);
  });
  it("rejects a reply whose ids do not match the manifest, without writing", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clipcopy-"));
    const manifestFile = path.join(dir, "clips.json");
    fs.writeFileSync(manifestFile, JSON.stringify(MANIFEST));
    const llm = mockLlm(JSON.stringify({ clips: [{ id: "other", title: "X" }] }));
    await expect(writeClipCopy({ manifestFile, llm })).rejects.toThrow(/不匹配/);
    expect(JSON.parse(fs.readFileSync(manifestFile, "utf8")).copy).toBeUndefined();
  });
  it("refuses an empty manifest and truncates oversized copy", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clipcopy-"));
    const manifestFile = path.join(dir, "clips.json");
    fs.writeFileSync(manifestFile, JSON.stringify({ clips: [] }));
    await expect(writeClipCopy({ manifestFile, llm: mockLlm(REPLY) })).rejects.toThrow(/没有 clips/);
    const long = JSON.stringify({ clips: [{ id: "clip-01", title: "字".repeat(80), hook: "h", caption: "c" }] });
    fs.writeFileSync(manifestFile, JSON.stringify(MANIFEST));
    const { copies } = await writeClipCopy({ manifestFile, llm: mockLlm(long) });
    expect(copies[0]!.title.length).toBeLessThanOrEqual(40);
  });
  it("does not call the model when briefs are built from metadata only", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clipcopy-"));
    const manifestFile = path.join(dir, "clips.json");
    fs.writeFileSync(manifestFile, JSON.stringify({ ...MANIFEST, clips: [{ ...MANIFEST.clips[0], motionScore: null }, MANIFEST.clips[1]] }));
    const chat = vi.fn().mockReturnValue(Promise.resolve({ text: REPLY }));
    await writeClipCopy({ manifestFile, llm: { chat } as never });
    const request = chat.mock.calls[0]![0] as { messages: Array<{ content: string }>; system: string };
    expect(request.system).toContain("不编造");
    expect(request.messages[0]!.content).toContain("clip-01");
    expect(request.messages[0]!.content).toContain("运动评分 无法测量");
    expect(request.messages[0]!.content).toContain("运动评分 210");
    expect(request.messages[0]!.content).not.toContain("long.mp4");
  });
});
