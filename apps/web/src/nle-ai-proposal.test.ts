import { expect, it } from "vitest";
import { parseNleProject } from "@glintai/scenescript";
import { applyNleAiEdits, validateNleAiProposal } from "./nle-ai-proposal";
import { createNleSession } from "./nle-session";

const base = () => parseNleProject({ schemaVersion: 1, id: "demo", title: "片子", fps: 30, width: 1280, height: 720, tracks: [
  { id: "open", kind: "text", name: "字幕", clips: [
    { id: "a", kind: "text", text: "原文", startMs: 0, durationMs: 1000 },
    { id: "c", kind: "text", text: "第二句", startMs: 2000, durationMs: 1000 },
  ] },
  { id: "locked", kind: "text", name: "锁定", locked: true, clips: [{ id: "b", kind: "text", text: "保留", startMs: 0, durationMs: 4000 }] },
] });
it("applies multi-field edits as one undoable transaction without changing locked tracks", () => {
  const project = base(), result = applyNleAiEdits(project, [{ id: "a", text: "新文", startMs: 200, durationMs: 1200, fontSize: 48, color: "#ffaa22", weight: 700, align: "center" }, { id: "c", startMs: 2500 }]);
  expect(result.tracks[0]!.clips[0]).toMatchObject({ text: "新文", startMs: 200, durationMs: 1200, fontSize: 48, color: "#ffaa22", weight: 700, align: "center" });
  expect(result.tracks[0]!.clips[1]).toMatchObject({ startMs: 2500, durationMs: 1000 });
  expect(result.tracks[1]).toEqual(project.tracks[1]); expect(project.tracks[0]!.clips[0]).toMatchObject({ text: "原文", startMs: 0 });
  const session = createNleSession(project); expect(session.apply(result, "AI 文字及时间").ok).toBe(true);
  expect(session.undo()).toBe(true); expect(session.document()).toEqual(project);
});
it("rejects unknown, duplicate, locked, invalid and extra fields", () => {
  const project = base();
  for (const edits of [[{ id: "b", startMs: 1 }], [{ id: "missing", text: "x" }], [{ id: "a", text: "x" }, { id: "a", durationMs: 1000 }], [{ id: "a", src: "assets/x.png" }], [{ id: "a", startMs: 0.5 }], [{ id: "a", durationMs: 99 }], [{ id: "a", fontSize: 241 }], [{ id: "a", color: "red" }], [{ id: "a", weight: 500 }], [{ id: "a", align: "justify" }]]) {
    expect(() => applyNleAiEdits(project, edits)).toThrow();
  }
});
it("rejects out-of-timeline, newly overlapping and expanded existing overlaps", () => {
  const project = base();
  expect(() => applyNleAiEdits(project, [{ id: "a", startMs: 3500, durationMs: 1000 }])).toThrow(/时间轴/);
  expect(() => applyNleAiEdits(project, [{ id: "a", startMs: 1500, durationMs: 1000 }])).toThrow(/重叠/);
  const overlap = parseNleProject({ ...project, tracks: [{ ...project.tracks[0], clips: [project.tracks[0]!.clips[0], { ...project.tracks[0]!.clips[1], startMs: 800 }] }, project.tracks[1]] });
  expect(() => applyNleAiEdits(overlap, [{ id: "a", startMs: 100 }])).toThrow(/重叠/);
  expect(applyNleAiEdits(overlap, [{ id: "a", durationMs: 900 }]).tracks[0]!.clips[0]!.durationMs).toBe(900);
});
it("preserves keyframes, transitions and source clocks when trimming", () => {
  const project = base(), clip = project.tracks[0]!.clips[0]!;
  const withClip = (extra: Record<string, unknown>) => parseNleProject({ ...project, tracks: [{ ...project.tracks[0], clips: [{ ...clip, ...extra }, project.tracks[0]!.clips[1]] }, project.tracks[1]] });
  expect(() => applyNleAiEdits(withClip({ keyframes: [{ ms: 800, opacity: 1 }] }), [{ id: "a", durationMs: 800 }])).toThrow(/关键帧/);
  expect(() => applyNleAiEdits(withClip({ transitionIn: { type: "fade", durationMs: 700 } }), [{ id: "a", durationMs: 600 }])).toThrow(/转场/);
  expect(() => applyNleAiEdits(withClip({ transitionIn: { type: "fade", durationMs: 500 }, transitionOut: { type: "fade", durationMs: 500 } }), [{ id: "a", durationMs: 900 }])).toThrow(/转场/);
  expect(() => applyNleAiEdits(withClip({ speedRamp: { durationMs: 1000, offsetMs: 0 } }), [{ id: "a", durationMs: 900 }])).toThrow(/变速/);
});
it("revalidates malicious server responses independently before browser adoption", () => {
  const project = base();
  const altered = structuredClone(project); altered.tracks[0]!.clips[0]!.startMs = 1900;
  expect(() => validateNleAiProposal(project, altered)).toThrow(/重叠/);
  const changedLocked = structuredClone(project); changedLocked.tracks[1]!.clips[0]!.durationMs = 3000;
  expect(() => validateNleAiProposal(project, changedLocked)).toThrow(/允许范围/);
  const changedMetadata = structuredClone(project); changedMetadata.width = 640;
  expect(() => validateNleAiProposal(project, changedMetadata)).toThrow(/允许范围/);
});
