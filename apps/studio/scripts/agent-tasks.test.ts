import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeTaskPlan, validateTaskPlan, type TaskPlan } from "./agent-tasks";
const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), "glint-task-"));
const plan: TaskPlan = { version: 1, title: "连续任务", steps: [{ id: "first", tool: "srt", args: [], dependsOn: [], outputs: ["first.txt"] }, { id: "second", tool: "qa", args: [], dependsOn: ["first"], outputs: ["second.txt"] }] };

describe("persistent task tree", () => {
  it("resumes a failed step without rerunning finished work", async () => {
    const root = fixture(), calls: string[] = [];
    try {
      await expect(executeTaskPlan({ plan, baseDir: root, directory: path.join(root, "run"), execute: async step => { calls.push(step.id); if (step.id === "second") throw new Error("transient failure"); fs.writeFileSync(path.join(root, step.outputs[0]!), "done"); } })).rejects.toThrow("transient");
      const result = await executeTaskPlan({ plan, baseDir: root, directory: path.join(root, "run"), execute: async step => { calls.push(step.id); fs.writeFileSync(path.join(root, step.outputs[0]!), "done"); } });
      expect(calls).toEqual(["first", "second", "second"]); expect(result.steps.second!.attempts).toBe(2);
      expect(fs.readFileSync(path.join(root, "run/events.jsonl"), "utf8")).toContain("cache-hit");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("does not overwrite changed completed artifacts", async () => {
    const root = fixture();
    try {
      const execute = async (step: TaskPlan["steps"][number]) => { fs.writeFileSync(path.join(root, step.outputs[0]!), "done"); };
      await executeTaskPlan({ plan, baseDir: root, directory: path.join(root, "run"), execute });
      fs.writeFileSync(path.join(root, "first.txt"), "user changed");
      await expect(executeTaskPlan({ plan, baseDir: root, directory: path.join(root, "run"), execute })).rejects.toThrow("artifact missing or changed");
      expect(fs.readFileSync(path.join(root, "first.txt"), "utf8")).toBe("user changed");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("rejects a changed plan and concurrent lock", async () => {
    const root = fixture();
    try {
      const directory = path.join(root, "run"); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "run.lock"), "busy");
      await expect(executeTaskPlan({ plan, baseDir: root, directory, execute: async () => {} })).rejects.toThrow();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it.each([
    { ...plan, steps: [{ ...plan.steps[0]!, tool: "bash" }] },
    { ...plan, steps: [{ ...plan.steps[0]!, dependsOn: ["first"] }] },
    { ...plan, steps: [{ ...plan.steps[0]!, args: ["--api-key=secret"] }] },
    { ...plan, steps: [{ ...plan.steps[0]!, tool: "media", args: ["--model=paid"] }] },
  ])("rejects unsafe plans", value => expect(() => validateTaskPlan(value)).toThrow());
});
