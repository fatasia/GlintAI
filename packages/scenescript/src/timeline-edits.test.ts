import { describe, expect, it } from "vitest";
import { parseProject } from "./parse";
import { buildTimeline } from "./timeline";
import { editTimeline, type TimelineCommand } from "./timeline-edits";
import type { SceneScriptProject } from "./types";

const title = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: "title", title: id, narration: { text: "Narration", durationMs: 2000 }, ...extra,
});
const video = (id = "one", extra: Record<string, unknown> = {}) => title(id, {
  kind: "video", src: "assets/source.mp4", speed: 2, trimStartSec: 2, trimEndSec: 12, ...extra,
});
const project = (scenes = [title("one"), title("two"), title("three")], extra = {}) => parseProject({
  schemaVersion: 1, id: "timeline", title: "Timeline", aspect: "16:9", knowledgeSources: [], scenes, ...extra,
});
const split: TimelineCommand = { type: "split", sceneId: "one", atMs: 750, newSceneId: "new", duplicateText: true };
const trim: TimelineCommand = { type: "trim", sceneId: "one", edge: "start", deltaMs: 500 };
const roll: TimelineCommand = { type: "roll", sceneId: "one", deltaMs: 500 };
const commands: TimelineCommand[] = [trim, roll, split,
  { type: "slip", sceneId: "one", deltaMs: 500 }, { type: "ripple-delete", sceneId: "one" }];
const durations = (p: SceneScriptProject) => buildTimeline(p).entries.map(e => e.durationMs);

function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
}

describe("immutable timeline editing", () => {
  it("locks and unlocks without mutating a deeply frozen project", () => {
    const p = project();
    freeze(p);
    const locked = editTimeline(p, { type: "lock", sceneId: "one", locked: true });
    expect(locked.scenes[0]!.locked).toBe(true);
    expect(p.scenes[0]!.locked).toBeUndefined();
    expect(editTimeline(locked, { type: "lock", sceneId: "one", locked: false }).scenes[0]!.locked).toBe(false);
  });
  it.each(commands)("does not mutate input on $type", command => {
    const p = project([video(), title("two"), title("three")]);
    const snapshot = structuredClone(p);
    freeze(p);
    const result = editTimeline(p, command);
    expect(p).toEqual(snapshot);
    expect(result).not.toBe(p);
    expect(parseProject(result)).toEqual(result);
  });
  it("ripple deletes and shifts every later scene", () => {
    const result = editTimeline(project(), { type: "ripple-delete", sceneId: "two" });
    expect(result.scenes.map(s => s.id)).toEqual(["one", "three"]);
    expect(buildTimeline(result).entries.map(e => e.startMs)).toEqual([0, 2000]);
  });
  it.each(["start", "end"] as const)("trims and extends the %s edge", edge => {
    expect(durations(editTimeline(project(), { ...trim, type: "trim", edge }))).toEqual([1500, 2000, 2000]);
    expect(durations(editTimeline(project(), { type: "trim", sceneId: "one", edge, deltaMs: -500 }))).toEqual([2500, 2000, 2000]);
  });
  it.each([500, -500])("rolls %dms with constant total and later starts", deltaMs => {
    const p = project([title("one"), title("two"), title("three", { locked: true })]);
    const result = editTimeline(p, { type: "roll", sceneId: "one", deltaMs });
    expect(durations(result)).toEqual([2000 + deltaMs, 2000 - deltaMs, 2000]);
    expect(buildTimeline(result).totalMs).toBe(buildTimeline(p).totalMs);
    expect(buildTimeline(result).entries[2]!.startMs).toBe(4000);
  });
  it("maps video trim, roll and slip to source seconds at speed", () => {
    const p = project([video(), video("two"), title("three", { locked: true })]);
    expect(editTimeline(p, { ...trim, type: "trim", deltaMs: 0 }).scenes[0]).toMatchObject({ trimStartSec: 2, trimEndSec: 6 });
    const shortened = editTimeline(project([video()]), trim);
    expect(shortened.scenes[0]).toMatchObject({ trimStartSec: 3, trimEndSec: 6, narration: { durationMs: 1500 } });
    expect(editTimeline(project([video()]), { type: "trim", sceneId: "one", edge: "end", deltaMs: -500 }).scenes[0])
      .toMatchObject({ trimStartSec: 2, trimEndSec: 7, narration: { durationMs: 2500 } });
    const rolled = editTimeline(p, roll);
    expect(rolled.scenes[0]).toMatchObject({ trimStartSec: 2, trimEndSec: 7 });
    expect(rolled.scenes[1]).toMatchObject({ trimStartSec: 3, trimEndSec: 6 });
    const slipped = editTimeline(p, { type: "slip", sceneId: "one", deltaMs: 500 });
    expect(slipped.scenes[0]).toMatchObject({ trimStartSec: 3, trimEndSec: 7 });
    expect(durations(slipped)).toEqual(durations(p));
  });
  it("splits video at a local speed-mapped boundary and preserves static elements", () => {
    const p = project([video("one", { elements: [{ id: "label", kind: "text", text: "Hello" }] }), title("two", { locked: true })]);
    const result = editTimeline(p, split);
    expect(durations(result)).toEqual([750, 1250, 2000]);
    expect(result.scenes[0]).toMatchObject({ id: "one", trimStartSec: 2, trimEndSec: 3.5 });
    expect(result.scenes[1]).toMatchObject({ id: "new", trimStartSec: 3.5, trimEndSec: 6 });
    expect(result.scenes[1]!.elements).toEqual(p.scenes[0]!.elements);
    expect(result.scenes[1]!.elements).not.toBe(result.scenes[0]!.elements);
    expect(result.scenes[1]!.narration.text).toBe("Narration");
    expect(buildTimeline(result).totalMs).toBe(4000);
  });
  it("accepts exactly 100ms and inferred narration duration", () => {
    expect(durations(editTimeline(project(), { ...split, type: "split", atMs: 100 }))[0]).toBe(100);
    const p = project([title("one", { narration: { text: "Estimated narration" } })]);
    expect(durations(editTimeline(p, trim))[0]).toBe(buildTimeline(p).totalMs - 500);
  });
});

describe("safety refusal boundaries", () => {
  it.each(commands)("rejects locked target for $type", command => {
    expect(() => editTimeline(project([video("one", { locked: true }), title("two")]), command)).toThrow(/locked/);
  });
  it.each([trim, { type: "ripple-delete", sceneId: "one" } as TimelineCommand])("rejects downstream locked movement for $type", command => {
    expect(() => editTimeline(project([title("one"), title("two", { locked: true })]), command)).toThrow(/locked/);
  });
  it("rejects locked roll neighbor, missing neighbor and deleting the final scene", () => {
    expect(() => editTimeline(project([title("one"), title("two", { locked: true })]), roll)).toThrow(/locked/);
    expect(() => editTimeline(project([title("one")]), roll)).toThrow(/next scene/);
    expect(() => editTimeline(project([title("one")]), { type: "ripple-delete", sceneId: "one" })).toThrow(/last scene/);
  });
  it.each([NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects noninteger time %s", deltaMs => {
    for (const type of ["trim", "roll", "slip"] as const) {
      expect(() => editTimeline(project([video(), title("two")]), { type, sceneId: "one", edge: "start", deltaMs } as TimelineCommand)).toThrow(/integer/);
    }
    expect(() => editTimeline(project(), { ...split, type: "split", atMs: deltaMs })).toThrow(/integer/);
  });
  it.each([-1, 0, 99, 1901, 2000, 2100])("rejects split boundary %d", atMs => {
    expect(() => editTimeline(project(), { ...split, type: "split", atMs })).toThrow(/100ms/);
  });
  it("rejects too-short trim and roll on either side", () => {
    expect(() => editTimeline(project(), { ...trim, type: "trim", deltaMs: 1901 })).toThrow(/100ms/);
    for (const deltaMs of [-1901, 1901]) expect(() => editTimeline(project(), { type: "roll", sceneId: "one", deltaMs })).toThrow(/100ms/);
  });
  it("validates IDs, input schema, command kind, edge and explicit text consent", () => {
    expect(() => editTimeline(project(), { type: "lock", sceneId: "absent", locked: true })).toThrow(/Unknown scene/);
    expect(() => editTimeline(project(), { ...split, type: "split", newSceneId: "two" })).toThrow(/Duplicate/);
    expect(() => editTimeline(project(), { ...split, type: "split", newSceneId: "Bad ID" })).toThrow(/kebab-case/);
    expect(() => editTimeline(project(), { ...split, type: "split", duplicateText: undefined })).toThrow(/duplicateText/);
    const p = project(); p.scenes[1]!.id = "one";
    expect(() => editTimeline(p, trim)).toThrow(/duplicate scene/);
    expect(() => editTimeline(project(), { type: "oops", sceneId: "one" } as unknown as TimelineCommand)).toThrow(/Unknown timeline/);
    expect(() => editTimeline(project(), { ...trim, edge: "middle" } as unknown as TimelineCommand)).toThrow(/edge/);
  });
  const unsupported = [
    { narration: { text: "Audio", durationMs: 2000, audioRef: "voice.mp3" } },
    { narration: { text: "Timing", durationMs: 2000, audioOffsetMs: 10 } },
    { narration: { text: "Timing", durationMs: 2000, segments: [{ text: "Word", words: [{ text: "Word", startMs: 0, endMs: 200 }] }] } },
    { elements: [{ id: "a", kind: "text", text: "A" }], tracks: [{ elementId: "a", property: "x", keyframes: [{ atMs: 0, value: 0 }] }] },
    { camera: { type: "push" } }, { transition: { in: "fade" } }, { beatPulse: { beatsMs: [100] } },
    { effects: [{ id: "animated", kind: "brightness", value: 1, keyframes: [{ atMs: 0, value: 0 }, { atMs: 1000, value: 1 }] }] },
    { effects: [{ id: "windowed", kind: "sepia", value: 1, startMs: 300, endMs: 1000 }] },
    { kind: "html", html: "<p>Animated</p>", animation: "gsap" }, { kind: "three", model: "sphere" },
    { kind: "chart", chartType: "bar", data: [{ label: "A", value: 2 }] },
  ];
  it.each(unsupported)("refuses unsupported continuity instead of dropping fields: %j", extra => {
    const p = project([title("one", extra), title("two")]);
    const snapshot = structuredClone(p);
    for (const command of [trim, roll, split]) expect(() => editTimeline(p, command)).toThrow(/unsupported|continuity/);
    expect(p).toEqual(snapshot);
  });
  it("rejects retiming the roll neighbor's audio and adjacent transitions", () => {
    expect(() => editTimeline(project([title("one"), title("two", unsupported[0])]), roll)).toThrow(/audio/);
    const p = project([title("one"), title("two", { transition: { in: "fade", overlapMs: 500 } })]);
    for (const command of [trim, roll, split, commands[4]!]) expect(() => editTimeline(p, command)).toThrow(/transition/);
  });
  it("protects SFX references and preserves music / untouched audio", () => {
    const p = project(undefined, { sfx: [{ sceneId: "one", effect: "pop" }], music: { src: "music.wav" } });
    for (const command of [trim, roll, split, commands[4]!]) expect(() => editTimeline(p, command)).toThrow(/SFX/);
    const result = editTimeline(p, { type: "trim", sceneId: "three", edge: "end", deltaMs: 100 });
    expect(result.sfx).toEqual(p.sfx); expect(result.music).toEqual(p.music);
  });
  it("slip preserves narration audio, timings and overlay animation without retiming them", () => {
    const p = project([video("one", {
      narration: { text: "Audio", durationMs: 2000, audioRef: "voice.mp3", segments: [{ text: "A", startMs: 0, endMs: 1000 }] },
      elements: [{ id: "a", kind: "text", text: "A" }],
      tracks: [{ elementId: "a", property: "x", keyframes: [{ atMs: 0, value: 0 }] }],
    })]);
    const result = editTimeline(p, { type: "slip", sceneId: "one", deltaMs: -500 });
    expect(result.scenes[0]!.narration).toEqual(p.scenes[0]!.narration);
    expect(result.scenes[0]!.tracks).toEqual(p.scenes[0]!.tracks);
    expect(result.scenes[0]).toMatchObject({ trimStartSec: 1, trimEndSec: 5 });
  });
  it("rejects invalid existing duration and preserves inputs on source errors", () => {
    expect(() => editTimeline(project([title("one", { narration: { text: "Short", durationMs: 99 } })]), trim)).toThrow(/100ms/);
    const p = project([video()]);
    const snapshot = structuredClone(p);
    freeze(p);
    expect(() => editTimeline(p, { type: "slip", sceneId: "one", deltaMs: 10000 })).toThrow(/bounds/);
    expect(p).toEqual(snapshot);
  });
  it("rejects source underflow, overflow, invalid windows and nonvideo slip", () => {
    const p = project([video()]);
    for (const deltaMs of [-1500, 4000]) expect(() => editTimeline(p, { type: "slip", sceneId: "one", deltaMs })).toThrow(/bounds/);
    expect(() => editTimeline(p, { ...trim, type: "trim", deltaMs: -1500 })).toThrow(/bounds/);
    expect(() => editTimeline(p, { type: "trim", sceneId: "one", edge: "end", deltaMs: -4000 })).toThrow(/bounds/);
    expect(() => editTimeline(project([video("one", { trimEndSec: 3 })]), trim)).toThrow(/bounds/);
    expect(() => editTimeline(project(), { type: "slip", sceneId: "one", deltaMs: 100 })).toThrow(/video/);
    const unknownEnd = project([video("one", { trimEndSec: undefined })]);
    expect(() => editTimeline(unknownEnd, { type: "slip", sceneId: "one", deltaMs: 100 })).toThrow(/bounds/);
    expect(editTimeline(unknownEnd, split).scenes[1]).toMatchObject({ trimStartSec: 3.5, trimEndSec: 6 });
  });
});
