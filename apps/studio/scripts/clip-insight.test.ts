// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mockLlm } from "@glintai/llm";
import { pickHighlights } from "./clip-insight";

const MANIFEST = {
  source: { videoPath: "long.mp4", durationMs: 40_000 },
  clips: [
    { id: "clip-01", startMs: 0, endMs: 18_000, motionScore: 600, shotCount: 2, file: "assets/clip-01.mp4" },
    { id: "clip-02", startMs: 18_000, endMs: 33_000, motionScore: 210, shotCount: 1, file: "assets/clip-02.mp4" },
  ],
};
const REPLY = JSON.stringify({ highlights: [{ index: 0, reason: "高运动开场" }] });

describe("CLIP-02 highlights", () => {
  let dir = "";
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ""; });

  it("marks the chosen clips and records reasons without inventing ids", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-insight-"));
    const manifestFile = path.join(dir, "clips.json");
    fs.writeFileSync(manifestFile, JSON.stringify(MANIFEST));
    const { highlights } = await pickHighlights({ manifestFile, llm: mockLlm(REPLY), top: 2 });
    expect(highlights).toEqual(["clip-01"]);
    const saved = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    expect(saved.clips[0].highlight).toBe(true);
    expect(saved.clips[0].highlightReason).toBe("高运动开场");
    expect(saved.clips[1].highlight).toBe(false);
  });
  it("passes unknown motion as unavailable rather than zero", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-insight-"));
    const manifestFile = path.join(dir, "clips.json");
    fs.writeFileSync(manifestFile, JSON.stringify({ ...MANIFEST, clips: [{ ...MANIFEST.clips[0], motionScore: null }, MANIFEST.clips[1]] }));
    const chat = vi.fn().mockResolvedValue({ text: REPLY });
    await pickHighlights({ manifestFile, llm: { chat } as never });
    const request = chat.mock.calls[0]![0] as { messages: Array<{ content: string }> };
    expect(request.messages[0]!.content).toContain("运动无法测量");
    expect(request.messages[0]!.content).toContain("运动210");
  });
  it("fails closed when the model returns no valid indexes", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-insight-"));
    const manifestFile = path.join(dir, "clips.json");
    fs.writeFileSync(manifestFile, JSON.stringify(MANIFEST));
    await expect(pickHighlights({ manifestFile, llm: mockLlm(JSON.stringify({ highlights: [{ index: 9 }] })) })).rejects.toThrow(/有效/);
  });
});
