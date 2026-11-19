import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { runRecipe } from "./recipe-cli";
import { approveRecipe, executeRecipe, recipeStatus } from "./recipe-runtime";
import { loadRecipe } from "./recipe-adapter";
import { executeAgentStep } from "./recipe-step";
const documents = [
  "# 观察水的状态\n\n## 固态\n冰保持形状。\n\n## 液态\n水可以流动。\n",
  "# 整理学习笔记\n\n## 记录\n先写观察到的事实。\n\n## 核对\n再区分事实和推测。\n",
  "# Caring for a seedling\n\n## Light\nPlace the pot near a bright window.\n\n## Water\nCheck the soil before adding water.\n",
];
it.skipIf(process.env.GLINT_RECIPE_E2E !== "1")(
  "renders three owned documents and resumes between steps without rerendering",
  async () => {
    const root =
      process.env.GLINT_RECIPE_EVIDENCE_DIR ??
      fs.mkdtempSync(path.join(os.tmpdir(), "recipe-render-"));
    fs.mkdirSync(root, { recursive: true });
    const summaries = [];
    for (const [index, source] of documents.entries())
      summaries.push(await renderDocument(root, index, source));
    fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify(summaries, null, 2));
  },
  120000,
);

async function renderDocument(root: string, index: number, source: string) {
  const sourceFile = path.join(root, "source-" + index + ".md"),
    directory = path.join(root, "recipe-" + index);
  fs.writeFileSync(sourceFile, source, { flag: "wx" });
  await runRecipe(["plan", "--source=" + sourceFile, "--out=" + directory]);
  const projectFile = path.join(directory, "project.json"),
    project = JSON.parse(fs.readFileSync(projectFile, "utf8"));

  for (const scene of project.scenes) scene.narration.durationMs = 2500;
  fs.writeFileSync(projectFile, JSON.stringify(project, null, 2));
  await runRecipe(["plan", "--dir=" + directory]);
  await approveRecipe(directory, loadRecipe(directory).binding.planDigest);
  const calls: string[] = [];
  const execute = async (
    step: Parameters<typeof executeAgentStep>[1],
    event: (message: string) => void,
  ) => {
    calls.push(step.id);
    await executeAgentStep(directory, step, event);
  };
  if (index === 0) {
    const controller = new AbortController();
    await expect(
      executeRecipe(directory, {
        signal: controller.signal,
        execute: async (step, event) => {
          await execute(step, event);
          controller.abort();
        },
      }),
    ).rejects.toThrow();
  }
  await executeRecipe(directory, { execute });
  await executeRecipe(directory, { execute });
  expect(calls).toEqual(["lint", "render", "qa"]);
  const status = recipeStatus(directory);
  expect(status.journal.steps.qa.state).toBe("completed");
  const receipt = JSON.parse(
    fs.readFileSync(path.join(directory, "explainer.mp4.receipt.json"), "utf8"),
  );
  const qa = JSON.parse(fs.readFileSync(path.join(directory, "explainer.qa.json"), "utf8"));
  expect(qa.verdict).not.toBe("red");
  expect(receipt.format).toBe("glint-receipt");
  return { index, calls, qa: qa.verdict, artifacts: status.journal.steps };
}
