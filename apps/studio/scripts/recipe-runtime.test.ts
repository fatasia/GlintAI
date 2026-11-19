import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runRecipe } from "./recipe-cli";
import { executeRecipe, approveRecipe, recipeStatus } from "./recipe-runtime";
import { loadRecipe } from "./recipe-adapter";
import type { TaskStep } from "./agent-tasks";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture(visual = "mg") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-unit-"));
  roots.push(root);
  const source = path.join(root, "input.md"),
    directory = path.join(root, "recipe");
  fs.writeFileSync(
    source,
    "# 水的三种状态\n\n## 固态\n低温条件下可以结冰。\n\n## 液态\n常温下可观察到流动。\n",
  );
  await runRecipe(["plan", "--source=" + source, "--out=" + directory, "--visual=" + visual]);
  return directory;
}
const complete = (directory: string) =>
  vi.fn(async (step: TaskStep) => {
    for (const output of step.outputs)
      fs.writeFileSync(path.join(directory, output), JSON.stringify({ step: step.id }));
  });
it("requires exact approval and reuses completed artifacts without additional execution", async () => {
  const directory = await fixture(),
    execute = complete(directory);
  await expect(executeRecipe(directory, { execute })).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  const { binding } = loadRecipe(directory);
  await expect(approveRecipe(directory, "0".repeat(64))).rejects.toThrow("digest");
  await approveRecipe(directory, binding.planDigest);
  await executeRecipe(directory, { execute });
  await executeRecipe(directory, { execute });
  expect(execute).toHaveBeenCalledTimes(3);
  expect(recipeStatus(directory).journal.steps.qa.state).toBe("completed");
});
it.each(["source.md", "project.json"])("invalidates approval when %s changes", async (file) => {
  const directory = await fixture(),
    execute = complete(directory);
  await approveRecipe(directory, loadRecipe(directory).binding.planDigest);
  fs.appendFileSync(path.join(directory, file), " ");
  await expect(executeRecipe(directory, { execute })).rejects.toThrow("changed");
  expect(execute).not.toHaveBeenCalled();
});
it("refuses forged free AIGC and arbitrary tools/auto TTS before spawning", async () => {
  const directory = await fixture("aigc"),
    execute = complete(directory);
  await expect(approveRecipe(directory, loadRecipe(directory).binding.planDigest)).rejects.toThrow(
    "unknown",
  );
  const file = path.join(directory, "recipe.plan.json"),
    original = fs.readFileSync(file, "utf8");
  for (const mutate of [
    (plan: Record<string, unknown>) => {
      plan.quote = {
        amount: "0",
        unit: "CNY",
        source: "builtin-local-adapter",
        scope: "model-service-fee-only",
      };
    },
    (plan: Record<string, unknown>) => {
      plan.voice = "auto";
    },
    (plan: Record<string, unknown>) => {
      plan.steps = [{ id: "shell", tool: "bash", args: [], outputs: [], dependsOn: [] }];
    },
  ]) {
    const plan = JSON.parse(original);
    mutate(plan);
    fs.writeFileSync(file, JSON.stringify(plan));
    await expect(executeRecipe(directory, { execute })).rejects.toThrow();
  }
  expect(execute).not.toHaveBeenCalled();
});
it("resumes a between-step interruption but never replays failed or running attempts", async () => {
  const directory = await fixture(),
    controller = new AbortController(),
    execute = complete(directory);
  await approveRecipe(directory, loadRecipe(directory).binding.planDigest);
  await expect(
    executeRecipe(directory, {
      signal: controller.signal,
      execute: async (step) => {
        await execute(step);
        controller.abort();
      },
    }),
  ).rejects.toThrow();
  expect(execute).toHaveBeenCalledTimes(1);
  await executeRecipe(directory, { execute });
  expect(execute).toHaveBeenCalledTimes(3);
  const journalFile = path.join(directory, "task", "journal.json");
  for (const state of ["running", "failed"]) {
    const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
    journal.steps.render.state = state;
    fs.writeFileSync(journalFile, JSON.stringify(journal));
    await expect(executeRecipe(directory, { execute })).rejects.toThrow("no automatic replay");
  }
  expect(execute).toHaveBeenCalledTimes(3);
});
it("rejects modified outputs, overlapping approvals and replanning executed work", async () => {
  const directory = await fixture(),
    binding = loadRecipe(directory).binding;
  const results = await Promise.allSettled([
    approveRecipe(directory, binding.planDigest),
    approveRecipe(directory, binding.planDigest),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const execute = complete(directory);
  await executeRecipe(directory, { execute });
  fs.writeFileSync(path.join(directory, "explainer.mp4"), "changed");
  await expect(executeRecipe(directory, { execute })).rejects.toThrow("artifact");
  await expect(runRecipe(["plan", "--dir=" + directory])).rejects.toThrow("new directory");
  expect(execute).toHaveBeenCalledTimes(3);
});
it("refuses renderer resources and unexpected CLI parameters", async () => {
  const directory = await fixture(),
    file = path.join(directory, "project.json");
  const project = JSON.parse(fs.readFileSync(file, "utf8"));
  project.scenes[0].narration.audioRef = "../private.wav";
  fs.writeFileSync(file, JSON.stringify(project));
  await expect(runRecipe(["plan", "--dir=" + directory])).rejects.toThrow("external");
  await expect(runRecipe(["run", "--dir=" + directory, "--tts=auto"])).rejects.toThrow("option");
});

it("keeps a failed attempt and blocks a second execution without a new submission", async () => {
  const directory = await fixture();
  await approveRecipe(directory, loadRecipe(directory).binding.planDigest);
  const execute = vi.fn(async () => {
    throw new Error("response lost");
  });
  await expect(executeRecipe(directory, { execute })).rejects.toThrow("response lost");
  await expect(executeRecipe(directory, { execute })).rejects.toThrow("no automatic replay");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(recipeStatus(directory).journal.steps.lint.attempts).toBe(1);
});
it("replanning changed drafts invalidates old approval but preserves the edited project", async () => {
  const directory = await fixture(),
    old = loadRecipe(directory).binding.planDigest;
  await approveRecipe(directory, old);
  const file = path.join(directory, "project.json"),
    project = JSON.parse(fs.readFileSync(file, "utf8"));
  project.title = "确认后的新标题";
  const bytes = JSON.stringify(project);
  fs.writeFileSync(file, bytes);
  await runRecipe(["plan", "--dir=" + directory]);
  expect(fs.readFileSync(file, "utf8")).toBe(bytes);
  expect(loadRecipe(directory).binding.planDigest).not.toBe(old);
  expect(recipeStatus(directory).approved).toBe(false);
  const execute = complete(directory);
  await expect(executeRecipe(directory, { execute })).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});
it("refuses a linked working directory and oversized source without spawning", async () => {
  const directory = await fixture(),
    link = path.join(path.dirname(directory), "linked");
  fs.symlinkSync(directory, link, "junction");
  await expect(approveRecipe(link, loadRecipe(directory).binding.planDigest)).rejects.toThrow(
    "Linked",
  );
  const file = path.join(path.dirname(directory), "oversized.md");
  fs.writeFileSync(file, "字".repeat(64000));
  await expect(
    runRecipe(["plan", "--source=" + file, "--out=" + path.join(path.dirname(directory), "large")]),
  ).rejects.toThrow("bounded");
  expect(fs.existsSync(path.join(path.dirname(directory), "large"))).toBe(false);
});
it("refuses scene overlays and project sound effects even after replanning", async () => {
  const directory = await fixture(),
    file = path.join(directory, "project.json"),
    raw = fs.readFileSync(file, "utf8");
  const project = JSON.parse(raw);
  project.scenes[0].elements = [
    { id: "remote", kind: "image", x: 0, y: 0, w: 1, h: 1, src: "private.png" },
  ];
  fs.writeFileSync(file, JSON.stringify(project));
  await expect(runRecipe(["plan", "--dir=" + directory])).rejects.toThrow();
  project.scenes[0].elements = [];
  project.sfx = [{ id: "sfx", src: "../private.wav", atMs: 0 }];
  fs.writeFileSync(file, JSON.stringify(project));
  await expect(runRecipe(["plan", "--dir=" + directory])).rejects.toThrow();
});
it("preserves AIGC and SAPI selections on replan unless explicitly replaced", async () => {
  const directory = await fixture("aigc");
  await runRecipe(["plan", "--dir=" + directory, "--voice=sapi"]);
  const before = loadRecipe(directory);
  expect(before.plan.visual).toBe("aigc");
  expect(before.plan.voice).toBe("sapi");
  await runRecipe(["plan", "--dir=" + directory]);
  expect(loadRecipe(directory)).toEqual(before);
  await runRecipe(["plan", "--dir=" + directory, "--visual=mg"]);
  expect(loadRecipe(directory).plan.voice).toBe("sapi");
  await approveRecipe(directory, loadRecipe(directory).binding.planDigest);
  await runRecipe(["plan", "--dir=" + directory, "--voice=existing"]);
  expect(recipeStatus(directory).approved).toBe(false);
  expect(loadRecipe(directory).plan.visual).toBe("mg");
});
it("refuses damaged prior plans instead of falling back while rebuilding valid inherited choices", async () => {
  const directory = await fixture("aigc"),
    file = path.join(directory, "recipe.plan.json");
  const original = fs.readFileSync(file, "utf8");
  for (const bytes of ["{", JSON.stringify({ ...JSON.parse(original), voice: "auto" })]) {
    fs.writeFileSync(file, bytes);
    await expect(runRecipe(["plan", "--dir=" + directory])).rejects.toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
  }
  const tampered = JSON.parse(original);
  tampered.steps[0].tool = "bash";
  tampered.quote.amount = "0";
  fs.writeFileSync(file, JSON.stringify(tampered));
  await runRecipe(["plan", "--dir=" + directory]);
  const rebuilt = loadRecipe(directory).plan;
  expect(rebuilt.visual).toBe("aigc");
  expect(rebuilt.quote.amount).toBeNull();
  expect(rebuilt.steps[0]!.tool).toBe("lint");
});
