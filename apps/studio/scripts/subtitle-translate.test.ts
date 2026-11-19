// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mockLlm, type LlmProvider } from "@glintai/llm";
import { formatVtt } from "./jianying";
import { translateCues, translateProjectSubtitles } from "./subtitle-translate";

const CUES = [
  { startMs: 0, endMs: 2000, text: "你好，世界" },
  { startMs: 2000, endMs: 4000, text: "第二条字幕" },
];
const REPLY = JSON.stringify({ cues: [{ i: 0, text: "Hello world" }, { i: 1, text: "Second caption" }] });

describe("AUDIO-06 subtitles", () => {
  it("formats WebVTT with a header and dot milliseconds", () => {
    const vtt = formatVtt(CUES);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:02.000");
    expect(vtt).not.toContain(",");
  });

  it("translates cue-by-cue and preserves count, order and timings", async () => {
    const requests: string[] = [];
    const llm: LlmProvider = { chat: async (request: Parameters<LlmProvider["chat"]>[0]) => { requests.push(request.messages[0]!.content as string); return { text: REPLY }; } } as unknown as LlmProvider;
    const translated = await translateCues(CUES, "en", llm);
    expect(translated.map(cue => cue.text)).toEqual(["Hello world", "Second caption"]);
    expect(translated[0]).toMatchObject({ startMs: 0, endMs: 2000 });
    const payload = JSON.parse(requests[0]!);
    expect(payload.lang).toBe("en");
    expect(payload.cues).toHaveLength(2);
  });

  it("fails closed when the model returns duplicate or out-of-block indexes", async () => {
    const duplicate = mockLlm(JSON.stringify({ cues: [{ i: 0, text: "a" }, { i: 0, text: "b" }] }));
    await expect(translateCues(CUES, "en", duplicate)).rejects.toThrow(/越界或重复/);
    const outOfBlock = mockLlm(JSON.stringify({ cues: [{ i: 5, text: "x" }] }));
    await expect(translateCues(CUES, "en", outOfBlock)).rejects.toThrow(/越界或重复/);
  });

  it("keeps the original text when the model skips a cue", async () => {
    const llm = mockLlm(JSON.stringify({ cues: [{ i: 1, text: "只有第二条" }] }));
    const translated = await translateCues(CUES, "en", llm);
    expect(translated.map(cue => cue.text)).toEqual(["你好，世界", "只有第二条"]);
  });

  it("writes a language-suffixed srt from a project", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-subtitle-"));
    const project = { schemaVersion: 1, id: "sub-demo", title: "字幕", aspect: "16:9" as const, fps: 30, knowledgeSources: [], scenes: [{ id: "s1", kind: "title" as const, title: "标题", subtitle: "副标", narration: { text: "你好，世界。第二条字幕。", durationMs: 4000 } }] };
    const llm = mockLlm(JSON.stringify({ cues: [{ i: 0, text: "Hello world" }, { i: 1, text: "Second caption" }] }));
    const out = path.join(dir, "sub-demo.en.srt");
    const result = await translateProjectSubtitles({ project: project as never, lang: "en", out, llm });
    expect(fs.readFileSync(result.file, "utf8")).toContain("Hello world");
    expect(result.file).toBe(out);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
