import { expect, it } from "vitest";
import { SceneScriptProject } from "@glintai/scenescript";
import { buildSeries, setShotEngine, applyIdentities } from "@glintai/composer/drama-series";
import {
  applyStoryboard,
  applyStoryboardShot,
  storyboardShots,
  storyboardVideoPrompt,
} from "./storyboard-project";
function fixture() {
  const base = buildSeries("第一场 茶馆 内 日\n老陈擦柜台。\n老陈：茶到了。", {
    id: "board",
    title: "Tea",
    engine: "mg",
    aspect: "16:9",
  });
  const series = setShotEngine(base, base.episodes[0]!.scenes[0]!.shots[0]!.id, "aigc");
  const row = storyboardShots(series, series.episodes[0]!.id, "doc")[0]!;
  const input = SceneScriptProject.parse({
    schemaVersion: 1,
    id: "board",
    title: "Tea",
    aspect: "16:9",
    knowledgeSources: [],
    scenes: [{ id: "old", kind: "title", title: "Old", narration: { text: "Old" } }],
  });
  const project = applyStoryboard(input, series, series.episodes[0]!.id, "doc", {
    [row.id]: "first.mp4",
  });
  return { project, series, row, episodeId: series.episodes[0]!.id };
}
it("replaces only one video while retaining narration, audio, text, animation, trims and every other scene", () => {
  const { project, series, row, episodeId } = fixture();
  project.music = { src: "bed.wav", volume: 0.4 };
  const first = project.scenes[0]!;
  first.narration.audioRef = "voice.wav";
  first.elements = [{ id: "caption", kind: "text", text: "Manual" }];
  first.tracks = [
    {
      elementId: "caption",
      property: "opacity",
      keyframes: [
        { atMs: 0, value: 0 },
        { atMs: 100, value: 1 },
      ],
    },
  ];
  if (first.kind === "video") {
    first.trimStartSec = 0.2;
    first.speed = 1.5;
  }
  project.scenes[1]!.locked = true;
  const original = JSON.stringify(project);
  const next = applyStoryboardShot(project, series, episodeId, "doc", row.id, {
    [row.id]: "replacement.mp4",
  });
  expect(next.scenes[0]).toEqual({ ...first, src: "assets/replacement.mp4" });
  expect(next.scenes.slice(1)).toEqual(project.scenes.slice(1));
  expect(next.music).toEqual(project.music);
  expect(JSON.stringify(project)).toBe(original);
  expect(() =>
    applyStoryboardShot({ ...project, frozen: true }, series, episodeId, "doc", row.id, {}),
  ).toThrow();
  first.locked = true;
  expect(() => applyStoryboardShot(project, series, episodeId, "doc", row.id, {})).toThrow();
  expect(() => applyStoryboardShot(project, series, episodeId, "doc", "missing", {})).toThrow();
});
it("passes the existing full identity, location and camera prompt to generation rather than a prose-only reconstruction", () => {
  const { series, episodeId } = fixture();
  const identified = applyIdentities(series, []);
  const row = storyboardShots(identified, episodeId, "doc")[0]!;
  expect(row.shot.videoPrompt.length).toBeGreaterThan(row.shot.action.length);
  expect(storyboardVideoPrompt(row)).toBe(row.shot.videoPrompt);
  expect(storyboardVideoPrompt(row)).toContain("秒");
});
it("replaces a procedural HTML placeholder through the same existing shot path", () => {
  const { project, series, row, episodeId } = fixture();
  project.scenes[0] = {
    id: row.id,
    kind: "html",
    animation: "three",
    html: "<div>Previs</div>",
    narration: { text: "Keep this voice", audioRef: "voice.wav", durationMs: 1000 },
    elements: [{ id: "caption", kind: "text", text: "Keep this caption" }],
  };
  const next = applyStoryboardShot(project, series, episodeId, "doc", row.id, {
    [row.id]: "finished.mp4",
  });
  expect(next.scenes[0]).toMatchObject({
    kind: "video",
    src: "assets/finished.mp4",
    narration: project.scenes[0]!.narration,
    elements: project.scenes[0]!.elements,
  });
  expect(next.scenes.slice(1)).toEqual(project.scenes.slice(1));
});
