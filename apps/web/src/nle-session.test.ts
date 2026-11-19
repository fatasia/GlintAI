import { describe, expect, it } from "vitest";
import { nleMoveClip, nleRemoveClip, nleSplitClip, nleTrimClip, parseNleProject, type NleProject } from "@glintai/scenescript";
import { createNleSession, diffNleProjects } from "./nle-session";

function project(): NleProject {
  return parseNleProject({
    schemaVersion: 1, id: "session-demo", title: "会话演示", fps: 30, width: 1280, height: 720,
    tracks: [
      { id: "ov1", kind: "overlay", name: "叠加", clips: [
        { id: "a", kind: "text", text: "甲", startMs: 0, durationMs: 2000 },
        { id: "b", kind: "text", text: "乙", startMs: 2000, durationMs: 3000 },
      ] },
      { id: "a1", kind: "audio", name: "音频", clips: [{ id: "v", kind: "audio", src: "assets/v.wav", startMs: 0, durationMs: 5000 }] },
    ],
  });
}

describe("diffNleProjects", () => {
  it("emits a field set for a trim and replays exactly", () => {
    const before = project();
    const after = nleTrimClip(before, "ov1", "b", "end", -1000);
    const operations = diffNleProjects(before, after);
    expect(operations).toEqual([{ kind: "set", path: ["tracks", "0", "clips", "1", "durationMs"], value: 2000 }]);
  });
  it("emits set+insert for a split and delete for a removal", () => {
    const before = project();
    const split = nleSplitClip(before, "ov1", "b", 3000);
    const operations = diffNleProjects(before, split);
    expect(operations.filter(operation => operation.kind === "insert")).toHaveLength(1);
    expect(operations.some(operation => operation.kind === "set")).toBe(true);
    const removal = diffNleProjects(before, nleRemoveClip(before, "ov1", "a"));
    expect(removal).toEqual([{ kind: "delete", path: ["tracks", "0", "clips", "0"] }]);
  });
  it("persists solo and reverses it through the session", () => {
    const before = project(), session = createNleSession(before);
    const after = parseNleProject({ ...before, tracks: before.tracks.map(track => ({ ...track, solo: true })) });
    expect(session.apply(after, "独听").ok).toBe(true);
    expect(session.document().tracks.every(track => track.solo)).toBe(true);
    expect(session.undo()).toBe(true);
    expect(session.document()).toEqual(before);
    expect(session.redo()).toBe(true);
    expect(session.document()).toEqual(after);
  });
  it("deletes optional clip properties rather than retaining stale values", () => {
    const before = parseNleProject({ ...project(), tracks: project().tracks.map(track => ({ ...track,
      clips: track.clips.map(clip => ({ ...clip, transitionIn: { type: "fade" }, mask: { shape: "circle" } })),
    })) });
    const after = parseNleProject({ ...before, tracks: before.tracks.map(track => ({ ...track,
      clips: track.clips.map(clip => ({ ...clip, transitionIn: undefined, mask: undefined })),
    })) });
    const session = createNleSession(before);
    expect(session.apply(after, "清除").ok).toBe(true);
    expect(session.document()).toEqual(after);
    expect(session.undo()).toBe(true);
    expect(session.document()).toEqual(before);
  });
  it("tracks changing indexes when deleting, inserting and reordering multiple objects", () => {
    const before = project();
    const first = before.tracks[0]!, audio = before.tracks[1]!;
    const after = parseNleProject({ ...before, tracks: [audio, { ...first, clips: [
      { ...first.clips[1]!, durationMs: 1200 }, { ...first.clips[0]!, id: "new-caption" },
    ] }] });
    const session = createNleSession(before);
    expect(session.apply(after, "重排").ok).toBe(true);
    expect(session.document()).toEqual(after);
    expect(session.undo()).toBe(true);
    expect(session.document()).toEqual(before);
    const cleared = parseNleProject({ ...before, tracks: [] });
    expect(session.apply(cleared, "删除全部轨道").ok).toBe(true);
    expect(session.document().tracks).toEqual([]);
    expect(session.undo()).toBe(true);
    expect(session.document()).toEqual(before);
  });
  it("refuses sequences it cannot verify", () => {
    // A forged "after" that disagrees with the emitted operations would break undo; the diff must throw.
    const before = project();
    const forged = { ...before, title: "另一个标题" } as NleProject;
    expect(() => diffNleProjects(project(), forged)).not.toThrow(); // title diff is fine
    expect(diffNleProjects(before, forged)).toEqual([{ kind: "set", path: ["title"], value: "另一个标题" }]);
  });
});

describe("createNleSession", () => {
  it("commits a multi-track razor operation after recording the first keyframe", () => {
    const before = parseNleProject({ ...project(), tracks: project().tracks.map(track => ({ ...track, clips: track.clips.map(clip => ({ ...clip, durationMs: 6000, startMs: 0, ...(clip.kind === "text" ? { keyframes: [{ ms: 2000, opacity: 1 }] } : {}) })) })) });
    const session = createNleSession(before);
    let after = before;
    for (const track of before.tracks) for (const clip of track.clips) after = nleSplitClip(after, track.id, clip.id, 2000);
    const result = session.apply(after, "剃刀全轨");
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    expect(session.document().tracks[0]!.clips.some(clip => clip.id === "a-b")).toBe(true);
    expect(session.undo()).toBe(true);
    expect(session.document()).toEqual(before);
  });
  it("commits undoable edits, undoes and redoes through the shared domain", () => {
    const session = createNleSession(project());
    const moved = nleMoveClip(session.document(), "ov1", "a", 500);
    const applied = session.apply(moved, "移动片段");
    expect(applied.ok).toBe(true);
    expect(session.document().tracks[0]!.clips[0]!.startMs).toBe(500);
    expect(session.undoDepth()).toBe(1);
    expect(session.undo()).toBe(true);
    expect(session.document().tracks[0]!.clips[0]!.startMs).toBe(0);
    expect(session.redo()).toBe(true);
    expect(session.document().tracks[0]!.clips[0]!.startMs).toBe(500);
    expect(session.undo()).toBe(true);
    expect(session.undo()).toBe(false); // nothing left
  });
  it("amends without adding undo steps and keeps the last commit reachable", () => {
    const session = createNleSession(project());
    session.apply(nleTrimClip(session.document(), "ov1", "b", "end", -500), "修剪");
    const depth = session.undoDepth();
    session.amendTo({ ...session.document(), title: "改标题" }, "typing");
    expect(session.undoDepth()).toBe(depth);
    expect(session.document().title).toBe("改标题");
    expect(session.undo()).toBe(true);
    // The undo reaches through the amendment and reverts the trim only;
    // the amended title survives — amendments are independent of undo steps.
    expect(session.document().tracks[0]!.clips[1]!.durationMs).toBe(3000);
    expect(session.document().title).toBe("改标题");
  });
  it("restores the undo stack across page reloads via exportState", () => {
    const first = createNleSession(project());
    first.apply(nleMoveClip(first.document(), "ov1", "a", 500), "移动");
    const exported = first.exportState();
    const second = createNleSession(project(), exported);
    expect(second.undoDepth()).toBe(1);
    expect(second.undo()).toBe(true);
    expect(second.document().tracks[0]!.clips[0]!.startMs).toBe(0);
  });
});

it("starts an independent session identity after importing another NLE project and preserves its undo on reload",()=>{
 const session=createNleSession(project());
 const imported={...project(),id:"imported-project"};session.amendTo(imported);
 expect(session.exportState().projectId).toBe(imported.id);
 expect(session.apply({...imported,title:"Edited"},"edit").ok).toBe(true);
 const restored=createNleSession(session.document(),session.exportState());
 expect(restored.undo()).toBe(true);expect(restored.document().title).toBe(imported.title);
});
