import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { browserSelection, requireBrowser, assertBrowserResults } from "./verify-browser-policy.mjs";

let root: string;
const core = ["creation-flow", "storyboard", "hybrid-creation", "reference-adoption"].map(name => `apps/web/server/${name}.browser.test.ts`);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-policy-"));
  fs.mkdirSync(path.join(root, "apps/web/server"), { recursive: true });
  for (const file of [...core, "apps/web/server/style-trial.browser.test.ts"]) fs.writeFileSync(path.join(root, file), "");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it("allows the clean-checkout core subset but retains full-suite and historical fixture requirements", () => {
  expect(browserSelection(root, core)).toEqual({ selected: core, requiresStyles: false });
  expect(() => browserSelection(root, [])).toThrow("Historical");
  expect(() => browserSelection(root, ["apps/web/server/style-trial.browser.test.ts"])).toThrow("Historical");
  fs.mkdirSync(path.join(root, "outputs/style-samples"), { recursive: true });
  expect(browserSelection(root, []).requiresStyles).toBe(true);
  expect(browserSelection(root, ["apps/web/server/style-trial.browser.test.ts"]).requiresStyles).toBe(true);
});

it("rejects options masquerading as selections, missing files and traversal", () => {
  for (const selected of [["--passWithNoTests"], ["missing.browser.test.ts"], ["../outside.browser.test.ts"], ["apps/web/server"]]) expect(() => browserSelection(root, selected)).toThrow();
});

it("requires a successful real-browser preflight boundary rather than allowing tests to skip", async () => {
  await expect(requireBrowser(async () => { throw new Error("No Chromium"); })).rejects.toThrow("No Chromium");
  await expect(requireBrowser(async () => "")).rejects.toThrow("no executable");
  await expect(requireBrowser(async () => "installed-browser")).resolves.toBe("installed-browser");
});

const report = () => ({ success: true, numPassedTests: 4, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  testResults: core.map(file => ({ name: path.join(root, file), assertionResults: [{ status: "passed" }] })) });
it("requires every requested file to execute and rejects all-skipped or missing reports", () => {
  expect(() => assertBrowserResults(report(), core)).not.toThrow();
  for (const bad of [null, {}, { ...report(), success: false }, { ...report(), numPassedTests: 0 }, { ...report(), numPendingTests: 1 }, { ...report(), numTodoTests: 1 }, { ...report(), testResults: report().testResults.slice(1) }]) expect(() => assertBrowserResults(bad, core)).toThrow();
  const skipped = report(); skipped.testResults[0]!.assertionResults[0]!.status = "pending";
  expect(() => assertBrowserResults(skipped, core)).toThrow();
  expect(() => assertBrowserResults({ ...report(), numPendingTests: 50 }, [])).not.toThrow();
});
