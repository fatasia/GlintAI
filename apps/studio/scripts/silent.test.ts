import { expect, it } from "vitest";
import { prepareSilentProject } from "./render";
import { MockTtsProvider } from "@glintai/tts";
import { parseProject } from "@glintai/scenescript";
it("preserves explicit silent shot durations without mutating the project", () => {
  const project = parseProject({ schemaVersion: 1, id: "mixed", title: "Mixed", aspect: "16:9", knowledgeSources: [], scenes: [
    { id: "video", kind: "video", src: "assets/tea.mp4", narration: { text: "镜头", durationMs: 2000 } },
    { id: "motion", kind: "title", title: "图形", narration: { text: "图形", durationMs: 3000 } },
  ] });
  const before = structuredClone(project), prepared = prepareSilentProject(project);
  expect(prepared.scenes.map(scene => scene.narration.durationMs)).toEqual([2000, 3000]);
  expect(prepared.scenes.every(scene => !scene.narration.audioRef)).toBe(true);
  expect(project).toEqual(before);
});
it("estimates narration when no explicit duration exists", async () => {
  const project = parseProject({ schemaVersion: 1, id: "estimated", title: "Estimated", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "Title", narration: { text: "一个没有设定时长的镜头。" } }] });
  const expected = await new MockTtsProvider().synthesize({ text: project.scenes[0]!.narration.text });
  expect(prepareSilentProject(project).scenes[0]!.narration.durationMs).toBe(expected.durationMs);
});
it("matches mock audio pacing and captions without allocating WAVs", async () => {
  const project = parseProject({ schemaVersion: 1, id: "silent", title: "Silent", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "Silent", narration: { text: "从一个具体问题开始。", audioRef: "audio/stale.wav", durationMs: 99 } }] });
  const prepared = prepareSilentProject(project);
  const audio = await new MockTtsProvider().synthesize({ text: project.scenes[0]!.narration.text });
  expect(prepared.scenes[0]!.narration.durationMs).toBe(audio.durationMs);
  expect(prepared.scenes[0]!.narration.segments![0]!.words).toEqual(audio.words);
  expect(prepared.scenes[0]!.narration.audioRef).toBeUndefined();
  expect(project.scenes[0]!.narration.audioRef).toBe("audio/stale.wav");
});
