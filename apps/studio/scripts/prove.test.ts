import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAssertions, proveProject } from "./prove";

const roots: string[] = [];
function fixture(tests: unknown): { projectPath: string; testsPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-prove-test-"));
  roots.push(root);
  const projectPath = path.join(root, "project.json");
  fs.writeFileSync(projectPath, JSON.stringify({
    schemaVersion: 1, id: "prove-fixture", title: "Prove", aspect: "16:9", fps: 30, knowledgeSources: [],
    scenes: [{ id: "one", kind: "title", title: "One", narration: { text: "hello", durationMs: 400 } }],
  }, null, 2));
  const testsPath = path.join(root, "glint.tests.json");
  fs.writeFileSync(testsPath, JSON.stringify(tests, null, 2));
  return { projectPath, testsPath };
}
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

describe("assertion parsing", () => {
  it("accepts the supported predicate set", () => {
    expect(parseAssertions({ assert: [{ scenes: { count: 1 } }, { only: ["one"] }] })).toHaveLength(2);
  });
  it("rejects unknown, empty and multi-key assertions", () => {
    expect(() => parseAssertions({ assert: [{ frame: { at: "1s" } }] })).toThrow(/unsupported predicate/);
    expect(() => parseAssertions({ assert: [] })).toThrow(/assert array/);
    expect(() => parseAssertions({ assert: [{ only: [], change: {} }] })).toThrow(/exactly one key/);
  });
});

describe("prove", () => {
  it("passes only/scenes/change when the plan stays inside the declared scope", () => {
    const { projectPath, testsPath } = fixture({ assert: [{ scenes: { count: 1 } }, { only: ["one"] }, { change: { maxCostCny: 0, maxModelCalls: 0 } }] });
    const report = proveProject({ projectPath, testsPath });
    expect(report.pass).toBe(true);
    expect(report.results.map(result => result.pass)).toEqual([true, true, true]);
  });
  it("fails when a declared-only scene would change", () => {
    const { projectPath, testsPath } = fixture({ assert: [{ only: [] }] });
    const report = proveProject({ projectPath, testsPath });
    expect(report.pass).toBe(false);
    expect(report.results[0]!.detail).toMatch(/unexpected scenes/);
  });
  it("fails determinism and output assertions without a receipt instead of passing silently", () => {
    const { projectPath, testsPath } = fixture({ assert: [{ determinism: { level: "L0" } }, { output: { minBytes: 1 } }] });
    const report = proveProject({ projectPath, testsPath });
    expect(report.pass).toBe(false);
    expect(report.results.map(result => result.pass)).toEqual([false, false]);
    expect(report.results[0]!.detail).toMatch(/receipt/);
  });
  it("fails a scenes count mismatch", () => {
    const { projectPath, testsPath } = fixture({ assert: [{ scenes: { count: 2 } }] });
    expect(proveProject({ projectPath, testsPath }).pass).toBe(false);
  });
});
