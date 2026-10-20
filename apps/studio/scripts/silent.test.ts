import { expect, it } from "vitest";
import { prepareSilentProject } from "./render";
import { MockTtsProvider } from "@glintai/tts";
import { parseProject } from "@glintai/scenescript";
it("matches mock audio pacing and captions without allocating WAVs", async () => {
  const project = parseProject({ schemaVersion: 1, id: "silent", title: "Silent", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "Silent", narration: { text: "从一个具体问题开始。", audioRef: "audio/stale.wav", durationMs: 99 } }] });
  const prepared = prepareSilentProject(project);
  const audio = await new MockTtsProvider().synthesize({ text: project.scenes[0]!.narration.text });
  expect(prepared.scenes[0]!.narration.durationMs).toBe(audio.durationMs);
  expect(prepared.scenes[0]!.narration.segments![0]!.words).toEqual(audio.words);
  expect(prepared.scenes[0]!.narration.audioRef).toBeUndefined();
  expect(project.scenes[0]!.narration.audioRef).toBe("audio/stale.wav");
});
