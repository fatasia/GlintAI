import { expect, it } from "vitest";
// @ts-expect-error JS HTTP server helper
import { createLlmSettings } from "./llm-settings.mjs";
it("keeps credentials out of public settings and refuses reusing a key on another host", () => {
  const env: Record<string, string> = {}, settings = createLlmSettings(env);
  settings.save({ baseUrl: "https://one.test/v1", apiKey: "private-test", model: "one" });
  expect(JSON.stringify(settings.read())).not.toContain("private-test");
  settings.save({ baseUrl: "https://one.test/v1", model: "two" });
  expect(env.GLINT_LLM_MODEL).toBe("two");
  expect(() => settings.save({ baseUrl: "https://other.test", model: "three" })).toThrow(/key/);
});
