// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseNleProject } from "@glintai/scenescript";
import { renderNleFrame, type NleFrameHost, karaokeCharStates } from "./nle-dom";

const project = (tracks: Array<Record<string, unknown>>) => parseNleProject({
  schemaVersion: 1, id: "meter", title: "Meter", fps: 30, width: 640, height: 360,
  tracks: tracks as never,
});

const audioTrack = (id: string, solo?: boolean, muted?: boolean) => ({
  id, kind: "audio" as const, name: id.toUpperCase(), ...(solo !== undefined ? { solo } : {}), ...(muted !== undefined ? { muted } : {}),
  clips: [{ id: `clip-${id}`, kind: "audio" as const, src: `assets/${id}.mp3`, startMs: 0, durationMs: 5000, volume: 0.8 }],
});

function makeHost(): NleFrameHost & { root: HTMLElement } {
  const root = document.createElement("div");
  document.body.append(root);
  return { root, resolveAsset: (src: string) => `http://test/${src.slice("assets/".length)}` };
}

describe("preview audio routing (nle-dom)", () => {
  afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

  it("plays every unmuted audio track when no solo is active", () => {
    const played: string[] = [];
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function(this: HTMLMediaElement) { played.push(this.getAttribute("src") ?? ""); return Promise.resolve(); });
    const host = makeHost();
    renderNleFrame(host, project([audioTrack("a1"), audioTrack("a2")]), 1000, { playing: true });
    expect(played).toHaveLength(2);
    expect(played.some(src => src.includes("a1.mp3"))).toBe(true);
    expect(played.some(src => src.includes("a2.mp3"))).toBe(true);
  });

  it("silences non-solo tracks in the preview while a solo track is active", () => {
    const played: string[] = [];
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function(this: HTMLMediaElement) { played.push(this.getAttribute("src") ?? ""); return Promise.resolve(); });
    const host = makeHost();
    renderNleFrame(host, project([audioTrack("a1", true), audioTrack("a2")]), 1000, { playing: true });
    expect(played).toHaveLength(1);
    expect(played[0]).toContain("a1.mp3");
  });

  it("keeps muted tracks silent with and without solo", () => {
    const played: string[] = [];
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function(this: HTMLMediaElement) { played.push(this.getAttribute("src") ?? ""); return Promise.resolve(); });
    const host = makeHost();
    renderNleFrame(host, project([audioTrack("a1", false, true), audioTrack("a2")]), 1000, { playing: true });
    expect(played).toHaveLength(1);
    expect(played[0]).toContain("a2.mp3");
    played.length = 0;
    renderNleFrame(host, project([audioTrack("a1", true, true), audioTrack("a2", true)]), 1000, { playing: true });
    expect(played).toHaveLength(1);
    expect(played[0]).toContain("a2.mp3");
  });

  it("updates video and audio instantaneous speed and source targets after out-of-order seeks", () => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const source = project([
      { id: "v1", kind: "video", name: "V", clips: [{ id: "v", kind: "video", src: "assets/v.mp4", startMs: 0, durationMs: 1000, trimStartMs: 2000, speedCurve: "in" }] },
      { id: "a1", kind: "audio", name: "A", clips: [{ id: "a", kind: "audio", src: "assets/a.wav", startMs: 0, durationMs: 1000, trimStartMs: 2000, speedCurve: "in" }] },
    ]);
    const host = makeHost();
    for (const time of [750, 250, 750]) {
      renderNleFrame(host, source, time);
      expect(host.media!.get("vid:v")!.playbackRate).toBeCloseTo(0.5 + time / 1000, 8);
      expect(host.media!.get("aud:a1:a")!.playbackRate).toBeCloseTo(0.5 + time / 1000, 8);
      expect(host.media!.get("aud:a1:a")!.preservesPitch).toBe(false);
      expect(host.targets!.get("vid:v")).toBeCloseTo(2 + time / 1000 / 2 + (time / 1000) ** 2 / 2, 8);
      expect(host.targets!.get("aud:a1:a")).toBe(host.targets!.get("vid:v"));
    }
  });

  it("pauses previously playing audio when solo or mute changes on an existing host", () => {
    const paused = new WeakMap<HTMLMediaElement, boolean>();
    vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function(this: HTMLMediaElement) { return paused.get(this) ?? true; });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function(this: HTMLMediaElement) { paused.set(this, false); return Promise.resolve(); });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function(this: HTMLMediaElement) { paused.set(this, true); });
    const host = makeHost();
    renderNleFrame(host, project([audioTrack("a1"), audioTrack("a2")]), 1000, { playing: true });
    const first = host.media!.get("aud:a1:clip-a1")!, second = host.media!.get("aud:a2:clip-a2")!;
    expect(first.paused).toBe(false); expect(second.paused).toBe(false);
    renderNleFrame(host, project([audioTrack("a1", true), audioTrack("a2")]), 1100, { playing: true });
    expect(first.paused).toBe(false); expect(second.paused).toBe(true);
    renderNleFrame(host, project([audioTrack("a1", true, true), audioTrack("a2")]), 1200, { playing: true });
    expect(first.paused).toBe(true); expect(second.paused).toBe(true);
    renderNleFrame(host, project([audioTrack("a1"), audioTrack("a2")]), 1300, { playing: true });
    renderNleFrame(host, project([audioTrack("a1"), audioTrack("a2")]), 1400, { playing: false });
    expect(first.paused).toBe(true); expect(second.paused).toBe(true);
  });
});

describe("karaoke caption states (AUDIO-05/07)", () => {
  it("lights chars proportionally with a single active char at the boundary", () => {
    const states = karaokeCharStates("abcd", 0.5);
    expect(states.map(state => state.char)).toEqual(["a", "b", "c", "d"]);
    expect(states.filter(state => state.sung).map(state => state.char)).toEqual(["a", "b"]);
    expect(states.find(state => state.active)?.char).toBe("c");
  });
  it("clamps progress and handles the fully sung state", () => {
    expect(karaokeCharStates("ab", -1).every(state => !state.sung)).toBe(true);
    expect(karaokeCharStates("ab", 2).every(state => state.sung && !state.active)).toBe(true);
  });
});
