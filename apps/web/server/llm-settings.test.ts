import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error JS HTTP server helper
import { createLlmSettings } from "./llm-settings.mjs";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it("keeps credentials out of public settings and refuses reusing a key on another host", () => {
  const env: Record<string, string> = {}, settings = createLlmSettings(env);
  settings.save({ baseUrl: "https://one.test/v1", apiKey: "private-test", model: "one" });
  expect(JSON.stringify(settings.read())).not.toContain("private-test");
  settings.save({ baseUrl: "https://one.test/v1", model: "two" });
  expect(env.GLINT_LLM_MODEL).toBe("two");
  expect(() => settings.save({ baseUrl: "https://other.test", model: "three" })).toThrow(/key/);
});
it("persists the model connection privately and restores it on restart", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-llm-settings-")); roots.push(root);
  const file = path.join(root, "llm-settings.json"), env: Record<string, string> = {};
  const settings = createLlmSettings(env, file);
  settings.save({ baseUrl: "https://one.test/v1", apiKey: "sk-abcdef123456", model: "deepseek-v4.1-flash", protocol: "openai" });
  expect(fs.existsSync(file)).toBe(true);
  expect(JSON.stringify(settings.read())).not.toContain("sk-abcdef123456");
  expect(settings.read()).toMatchObject({ configured: true, model: "deepseek-v4.1-flash", protocol: "openai", storage: "saved", keyHint: "…3456" });
  const reopened = createLlmSettings({}, file);
  expect(reopened.read()).toMatchObject({ configured: true, baseUrl: "https://one.test/v1", model: "deepseek-v4.1-flash", protocol: "openai", storage: "saved" });
  expect(JSON.stringify(reopened.read())).not.toContain("sk-abcdef123456");
});
