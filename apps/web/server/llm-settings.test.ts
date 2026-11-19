import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error JS HTTP server helper
import { createLlmSettings } from "./llm-settings.mjs";
const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it("caps connection probes without changing the selected model or retrying", async () => {
  const env = { GLINT_LLM_API_KEY: "test-private", GLINT_LLM_MODEL: "small-model", GLINT_LLM_PROTOCOL: "openai", GLINT_LLM_BASE_URL: "https://gateway.test/v1" };
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ choices: [{ message: { content: "GLINT_OK" } }] }));
  vi.stubGlobal("fetch", fetch);
  expect(await createLlmSettings(env).test()).toMatchObject({ passed: true, model: "small-model" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toMatchObject({ model: "small-model", max_completion_tokens: 64 });
  expect(env.GLINT_LLM_MODEL).toBe("small-model");
});
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

it("persists explicit reasoning effort and clears it when returning to provider default",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"glint-effort-"));roots.push(root);const file=path.join(root,"settings.json"),env:Record<string,string>={};
 const settings=createLlmSettings(env,file);settings.save({baseUrl:"https://one.test/v1",apiKey:"test-private",model:"one",reasoningEffort:"low"});
 expect(env.GLINT_LLM_REASONING_EFFORT).toBe("low");const restored:Record<string,string>={};const reopened=createLlmSettings(restored,file);
 expect(reopened.read().reasoningEffort).toBe("low");expect(restored.GLINT_LLM_REASONING_EFFORT).toBe("low");
 reopened.save({model:"one",reasoningEffort:""});expect(restored.GLINT_LLM_REASONING_EFFORT).toBe("");
 expect(()=>reopened.save({model:"one",reasoningEffort:"invalid"})).toThrow("reasoning");
});
