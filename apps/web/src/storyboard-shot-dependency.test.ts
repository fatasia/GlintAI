import { expect, it } from "vitest";
import { buildSeries, setShotEngine } from "@glintai/composer/drama-series";
import { storyboardShots } from "./storyboard-project";
import {
  storyboardDependencyDigest,
  storyboardGenerationInput,
} from "./storyboard-shot-dependency";
it("binds recovery to prompts, references and approval snapshots, not unrelated shots", async () => {
  const base = buildSeries("第一场 茶馆 内 日\n老陈：茶到了。", {
    id: "board",
    title: "Tea",
    engine: "mg",
    aspect: "16:9",
  });
  const source = base.episodes[0]!.scenes[0]!.shots.find((shot) => shot.characterIds.length)!;
  const series = setShotEngine(base, source.id, "aigc");
  const row = storyboardShots(series, series.episodes[0]!.id, "doc").find(
    (item) => item.shot.id === source.id,
  )!;
  const input = storyboardGenerationInput(series, row),
    digest = await storyboardDependencyDigest(input);
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  expect(await storyboardDependencyDigest(structuredClone(input))).toBe(digest);
  const changed = structuredClone(input);
  changed.prompt += "new look";
  expect(await storyboardDependencyDigest(changed)).not.toBe(digest);
  const next = structuredClone(series);
  next.characters[0]!.looks[0]!.approved = true;
  expect(await storyboardDependencyDigest(storyboardGenerationInput(next, row))).not.toBe(digest);
});
