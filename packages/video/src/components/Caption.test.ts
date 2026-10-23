import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseProject, type WordTiming } from "@glintai/scenescript";
import { describe, expect, it, vi } from "vitest";
import { Caption, captionPage } from "./Caption";

const clock = vi.hoisted(() => ({ frame: 0, fps: 30 }));
vi.mock("remotion", () => ({
  useCurrentFrame: () => clock.frame,
  useVideoConfig: () => ({ fps: clock.fps, width: 1080, height: 1920 }),
}));

const words: WordTiming[] = Array.from({ length: 80 }, (_, i) => ({
  text: String.fromCharCode(0x4e00 + i),
  startMs: i * 100 + (i >= 38 ? 300 : 0),
  endMs: (i + 1) * 100 + (i >= 38 ? 300 : 0),
}));
const scene = parseProject({
  schemaVersion: 1, id: "captions", title: "Captions", aspect: "9:16", knowledgeSources: [],
  scenes: [{ id: "one", kind: "title", title: "Title", narration: {
    text: "Fallback narration", durationMs: 10000,
    segments: [{ text: "Provider words", words }],
  } }],
}).scenes[0]!;

function render(frame: number, audioOffsetMs?: number, fps = 30, providerWords = true) {
  clock.frame = frame;
  clock.fps = fps;
  return renderToStaticMarkup(createElement(Caption, {
    scene: { ...scene, narration: { ...scene.narration, audioOffsetMs, segments: providerWords ? scene.narration.segments : undefined } },
    sceneDurationFrames: fps * 10,
  }));
}

describe("caption pages", () => {
  it("pages long captions by time and keeps the last page at the end", () => {
    const long = Array.from({ length: 100 }, (_, i) => ({ text: "字", startMs: i * 100, endMs: (i + 1) * 100 }));
    expect(captionPage(long, 0, 30)).toHaveLength(30);
    expect(captionPage(long, 3100, 30)[0]!.startMs).toBe(3000);
    expect(captionPage(long, 99999, 30)).toHaveLength(10);
  });
  it("selects the next page through a speech gap and retains the last page in postroll", () => {
    expect(captionPage(words, 3900, 38)[0]).toBe(words[38]);
    expect(captionPage(words, 8500, 38)[0]).toBe(words[76]);
    expect(captionPage([], 0, 38)).toEqual([]);
  });
});

describe("scene-local caption clock", () => {
  it.each([500, -500, 51, -51, 17, -17])("matches narration's rounded frame offset of %s ms", offset => {
    const shifted = render(60, offset);
    expect(shifted).toBe(render(60 - Math.round(offset / 1000 * 30), 0));
  });
  it("uses the composition fps when rounding offsets", () => {
    expect(render(24, 51, 24)).toBe(render(23, 0, 24));
    expect(render(24, -51, 24)).toBe(render(25, 0, 24));
  });
  it("hides captions before delayed speech, then highlights the first provider word", () => {
    expect(render(0, 500)).toBe("");
    expect(render(14, 500)).toBe("");
    const atStart = render(15, 500);
    expect(atStart).toBe(render(0, 0));
    expect(atStart).toContain(`color:var(--glint-color-accent)`);
    expect(atStart).toContain(`>${words[0]!.text}</span>`);
    expect(atStart).not.toContain("Fallback narration");
  });
  it("advances provider-word pages using the shifted clock, including gaps and postroll", () => {
    const advanced = render(99, -500); // caption time 3800, in the gap before page two.
    expect(advanced).toBe(render(114, 0));
    expect(advanced).toContain(`>${words[38]!.text}</span>`);
    expect(advanced).not.toContain(`>${words[0]!.text}</span>`);
    expect(render(255, 0)).toContain(`>${words[76]!.text}</span>`);
  });
  it("applies the same offset and hiding to estimated captions", () => {
    expect(render(14, 500, 30, false)).toBe("");
    expect(render(15, 500, 30, false)).toBe(render(0, 0, 30, false));
    expect(render(0, -500, 30, false)).toBe(render(15, 0, 30, false));
  });
  it("preserves zero-offset visuals and treats nonfinite offsets as zero", () => {
    const original = render(60);
    expect(render(60, 0)).toBe(original);
    for (const offset of [NaN, Infinity, -Infinity]) expect(render(60, offset)).toBe(original);
  });
});
