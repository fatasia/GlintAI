import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { recipeDescriptorFixture as descriptor } from "./recipe-v2-fixtures";
import { runRecipe } from "./recipe-cli";
import { loadRecipeV2 } from "./recipe-plan-v2";
import { approveRecipe, executeRecipe, recipeStatus } from "./recipe-runtime";
import { runAgentTask } from "./agent-task-cli";
import { recipeSceneProject, recipeDramaProject, recipeClipProjects } from "./recipe-projects";
import { probeRecipeAsset } from "./recipe-assets";
import type { RecipeInput } from "@glintai/composer/recipe-inputs";
let root: string;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZkAAAAASUVORK5CYII=",
  "base64",
);
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-v2-"));
  fs.writeFileSync(path.join(root, "image.png"), png);
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      path.join(root, "audio.wav"),
    ],
    { windowsHide: true },
  );
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:duration=2:rate=24",
      "-c:v",
      "libx264",
      path.join(root, "video.mp4"),
    ],
    { windowsHide: true },
  );
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
async function plan(input: RecipeInput, label: string) {
  const file = path.join(root, label + ".json"),
    directory = path.join(root, label);
  fs.writeFileSync(file, JSON.stringify(input));
  await runRecipe(["plan", "--recipe=" + input.recipeId, "--input=" + file, "--out=" + directory]);
  return { directory, ...loadRecipeV2(directory) };
}
it("lists and validates all six typed descriptors and binds their original media", async () => {
  const entries = await runRecipe(["list"]);
  expect(entries).toHaveLength(6);
  for (const id of [
    "source-explainer",
    "product-promo",
    "slides-video",
    "longform-clips",
    "drama-two-shot",
    "localized-voice",
  ] as const) {
    const { directory, plan: value } = await plan(descriptor(id), id);
    expect(value.version).toBe(2);
    expect(value.assets).toHaveLength(
      {
        "source-explainer": 0,
        "product-promo": 1,
        "slides-video": 0,
        "longform-clips": 1,
        "drama-two-shot": 2,
        "localized-voice": 1,
      }[id],
    );
    expect(value.quote.amount).toBe("0");
    expect(fs.existsSync(path.join(directory, "prepared.project.json"))).toBe(false);
    if (value.input.recipeId === "longform-clips")
      expect(
        recipeClipProjects(value.input, value.assets)[0]?.nle.tracks[0]?.clips[0],
      ).toMatchObject({ trimStartMs: 500, durationMs: 1000, volume: 0 });
    else if (value.input.recipeId === "drama-two-shot")
      expect(recipeDramaProject(value.input, value.assets).tracks[2]?.clips[0]).toMatchObject({
        src: "assets/speech.wav",
        durationMs: 1000,
      });
    else expect(recipeSceneProject(value.input, value.assets).scenes.length).toBeGreaterThan(0);
  }
});
it("runs the fixed materializer after exact approval and resumes without repeating completed work", async () => {
  const { directory, binding } = await plan(descriptor("source-explainer"), "resume");
  const execute = vi.fn(async () => {});
  await expect(executeRecipe(directory, { execute })).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  await approveRecipe(directory, binding.planDigest);
  const controller = new AbortController();
  const { executeRecipeV2Step } = await import("./recipe-execute-v2");
  await expect(
    executeRecipe(directory, {
      signal: controller.signal,
      execute: async (step) => {
        await executeRecipeV2Step(directory, loadRecipeV2(directory).plan, step);
        controller.abort();
      },
    }),
  ).rejects.toThrow();
  const first = recipeStatus(directory).journal.steps.materialize;
  expect(first).toMatchObject({ state: "completed", attempts: 1 });
  expect(
    JSON.parse(fs.readFileSync(path.join(directory, "prepared.project.json"), "utf8")).scenes
      .length,
  ).toBeGreaterThan(0);
  fs.writeFileSync(path.join(directory, "prepared.project.json"), "changed");
  await expect(executeRecipe(directory, { execute })).rejects.toThrow("artifact");
  expect(execute).not.toHaveBeenCalled();
});
it("blocks changed assets, altered input choices, forged zero-price generation and external tools", async () => {
  const input = descriptor("product-promo"),
    prepared = await plan(input, "asset-change");
  await approveRecipe(prepared.directory, prepared.binding.planDigest);
  fs.appendFileSync(path.join(prepared.directory, "assets/photo.png"), "x");
  const execute = vi.fn(async () => {});
  await expect(executeRecipe(prepared.directory, { execute })).rejects.toThrow("changed");
  const aigc = await plan({ ...input, visual: "aigc" }, "aigc");
  await expect(approveRecipe(aigc.directory, aigc.binding.planDigest)).rejects.toThrow("unknown");
  const file = path.join(aigc.directory, "recipe.plan.json"),
    forged = JSON.parse(fs.readFileSync(file, "utf8"));
  forged.quote.amount = "0";
  forged.quote.source = "builtin-local-adapter";
  fs.writeFileSync(file, JSON.stringify(forged));
  await expect(executeRecipe(aigc.directory, { execute })).rejects.toThrow("changed");
  expect(execute).not.toHaveBeenCalled();
  const task = path.join(root, "unapproved-task.json");
  fs.writeFileSync(
    task,
    JSON.stringify({
      version: 1,
      title: "Bypass",
      steps: [
        {
          id: "materialize",
          tool: "recipe-materialize",
          args: [],
          dependsOn: [],
          outputs: ["x.json"],
        },
      ],
    }),
  );
  await expect(runAgentTask(task, path.join(root, "unapproved-task"))).rejects.toThrow(
    "digest-approved",
  );
  expect(fs.existsSync(path.join(root, "unapproved-task"))).toBe(false);
});
it("rejects untranslated input, invalid windows, linked files and wrong media types", async () => {
  const localization = descriptor("localized-voice");
  if (localization.recipeId !== "localized-voice") throw new Error("fixture");
  localization.content.translations[0]!.text = "你好";
  await expect(plan(localization, "untranslated")).rejects.toThrow("Unchanged");
  const clips = descriptor("longform-clips");
  if (clips.recipeId !== "longform-clips") throw new Error("fixture");
  clips.content.windows[0]!.endMs = 3000;
  await expect(plan(clips, "window")).rejects.toThrow("source window");
  fs.symlinkSync(root, path.join(root, "linked-assets"), "junction");
  const linked = descriptor("product-promo");
  linked.assets[0]!.file = "linked-assets/image.png";
  await expect(plan(linked, "linked")).rejects.toThrow("Linked");
  expect(() => probeRecipeAsset(path.join(root, "video.mp4"), "audio")).toThrow("extension");
  const traversal = descriptor("product-promo");
  traversal.assets[0]!.file = "../image.png";
  await expect(plan(traversal, "traversal")).rejects.toThrow("safe relative");
});
it("rejects disguised playlists before decoding and keeps stale-language word timing out of localization", async () => {
  const fake = path.join(root, "playlist.wav");
  fs.writeFileSync(fake, "#EXTM3U\n#EXTINF:10\nfile:///private/audio.wav\n");
  expect(() => probeRecipeAsset(fake, "audio")).toThrow("playlists");
  const input = descriptor("localized-voice");
  if (input.recipeId !== "localized-voice") throw new Error("fixture");
  input.content.project.scenes[0]!.narration.segments = [
    { text: "你好", words: [{ text: "你好", startMs: 0, endMs: 1000 }] },
  ];
  input.content.project.scenes[0]!.narration.audioOffsetMs = 200;
  const prepared = await plan(input, "localized-timing");
  expect(
    recipeSceneProject(prepared.plan.input, prepared.plan.assets).scenes[0]!.narration,
  ).toMatchObject({ text: "Hello", audioRef: "assets/speech.wav" });
  expect(
    recipeSceneProject(prepared.plan.input, prepared.plan.assets).scenes[0]!.narration.segments,
  ).toBeUndefined();
  expect(
    recipeSceneProject(prepared.plan.input, prepared.plan.assets).scenes[0]!.narration
      .audioOffsetMs,
  ).toBeUndefined();
});
it("serializes v2 approvals, invalidates edited descriptors and never replays an uncertain attempt", async () => {
  const { directory, binding } = await plan(descriptor("source-explainer"), "v2-approval");
  const approvals = await Promise.allSettled([
    approveRecipe(directory, binding.planDigest),
    approveRecipe(directory, binding.planDigest),
  ]);
  expect(approvals.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const file = path.join(directory, "input.json"),
    input = JSON.parse(fs.readFileSync(file, "utf8"));
  input.content.markdown += "\nConfirmed edit.";
  fs.writeFileSync(file, JSON.stringify(input));
  const execute = vi.fn(async () => {
    throw new Error("response lost");
  });
  await expect(executeRecipe(directory, { execute })).rejects.toThrow("changed");
  expect(execute).not.toHaveBeenCalled();
  await runRecipe(["plan", "--dir=" + directory]);
  expect(recipeStatus(directory).approved).toBe(false);
  await approveRecipe(directory, loadRecipeV2(directory).binding.planDigest);
  await expect(executeRecipe(directory, { execute })).rejects.toThrow("response lost");
  await expect(executeRecipe(directory, { execute })).rejects.toThrow("no automatic replay");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(recipeStatus(directory).journal.steps.materialize).toMatchObject({
    state: "failed",
    attempts: 1,
  });
});
