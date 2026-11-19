import { expect, it } from "vitest";
import { SceneScriptProject, buildTimeline } from "@glintai/scenescript";
import { buildSeries, setShotEngine } from "@glintai/composer/drama-series";
import { applyStoryboard, storyboardShots, projectStoryboardChoices } from "./storyboard-project";

const SCRIPT = "第一场 茶馆 内 日\n老陈擦拭柜台。\n小满：新茶到了吗？\n老陈：到了。";
const project = () => SceneScriptProject.parse({ schemaVersion: 1, id: "board", title: "茶馆", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "old", kind: "title", title: "旧工程", narration: { text: "旧工程" } }] });
const series = () => buildSeries(SCRIPT, { engine: "mg", id: "board", title: "茶馆", aspect: "16:9" });
it("materializes actual MG and media scenes with the same planned timing", () => {
  const input = project(), base = series(), shot = base.episodes[0]!.scenes[0]!.shots[0]!;
  const mixed = setShotEngine(base, shot.id, "aigc"), keys = storyboardShots(mixed, mixed.episodes[0]!.id, "doc-a");
  const next = applyStoryboard(input, mixed, mixed.episodes[0]!.id, "doc-a", { [keys[0]!.id]: "tea.mp4" });
  expect(input.scenes[0]!.id).toBe("old"); expect(next.id).toBe(input.id); expect(next.scenes.map(scene => scene.kind)).toEqual(["video", "quote", "quote"]);
  expect(buildTimeline(next).totalMs).toBe(keys.reduce((sum, row) => sum + row.shot.durationMs, 0));
  expect(next.scenes[0]).toMatchObject({ src: "assets/tea.mp4" });
});
it("never substitutes MG for a missing AIGC asset and rejects unsafe paths atomically", () => {
  const input = project(), base = series(), shot = base.episodes[0]!.scenes[0]!.shots[0]!, mixed = setShotEngine(base, shot.id, "aigc"), rows = storyboardShots(mixed, mixed.episodes[0]!.id, "doc-a");
  expect(() => applyStoryboard(input, mixed, mixed.episodes[0]!.id, "doc-a", {})).toThrow(/素材/);
  expect(() => applyStoryboard(input, mixed, mixed.episodes[0]!.id, "doc-a", { [rows[0]!.id]: "../tea.mp4" })).toThrow();
  expect(input.scenes).toHaveLength(1); expect(input.scenes[0]!.id).toBe("old");
});
it("keeps manual edits and independent animation when an unchanged shot is applied again", () => {
  const base = series(), episode = base.episodes[0]!.id;
  const first = applyStoryboard(project(), base, episode, "doc-a", {});
  first.scenes[0]!.narration.text = "人工改过的旁白";
  first.scenes[0]!.elements = [{ id: "label", kind: "text", text: "定稿标注" }];
  expect(applyStoryboard(first, base, episode, "doc-a", {}).scenes).toEqual(first.scenes);
});
it("isolates screenplay identities and identical repeated scenes", () => {
  const base = series(), ep = base.episodes[0]!.id;
  expect(storyboardShots(base, ep, "doc-a")[0]!.id).not.toBe(storyboardShots(base, ep, "doc-b")[0]!.id);
  const repeated = buildSeries(`${SCRIPT}\n${SCRIPT}`, { engine: "mg", id: "board", title: "茶馆", aspect: "16:9", episodeSize: 1 });
  const ids = repeated.episodes.flatMap(episode => storyboardShots(repeated, episode.id, "doc-a").map(row => row.id)); expect(new Set(ids).size).toBe(ids.length);
});

it("recovers applied per-shot engines from a portable project without browser preferences", () => {
  const base = series(), first = base.episodes[0]!.scenes[0]!.shots[0]!, mixed = setShotEngine(base, first.id, "aigc");
  const rows = storyboardShots(mixed, mixed.episodes[0]!.id, "doc-a");
  const saved = applyStoryboard(project(), mixed, mixed.episodes[0]!.id, "doc-a", { [rows[0]!.id]: "tea.mp4" });
  const reopened = projectStoryboardChoices(series(), JSON.parse(JSON.stringify(saved)), "doc-a");
  expect(reopened.episodes[0]!.scenes[0]!.shots.map(shot => shot.engine)).toEqual(["aigc", "mg", "mg"]);
});
it("refuses frozen/locked edits and MG data it cannot infer from prose", () => {
  const base = series(), ep = base.episodes[0]!.id, input = project();
  expect(() => applyStoryboard({ ...input, frozen: true }, base, ep, "doc-a", {})).toThrow();
  input.scenes[0]!.locked = true; expect(() => applyStoryboard(input, base, ep, "doc-a", {})).toThrow();
  const first = base.episodes[0]!.scenes[0]!.shots[0]!;
  expect(() => applyStoryboard(project(), setShotEngine(base, first.id, "mg", "chart"), ep, "doc-a", {})).toThrow(/图表|数据/);
});
