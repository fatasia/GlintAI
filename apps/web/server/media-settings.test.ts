import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMediaSettings } from "./media-settings.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const file = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-media-settings-")); roots.push(root); return path.join(root, "media-settings.json"); };

describe("media gateway settings", () => {
  it("saves credentials privately and only exposes a masked hint", () => {
    const target = file(), settings = createMediaSettings({ file: target, env: {} });
    expect(settings.read()).toMatchObject({ configured: false, source: "none", protocol: "skills" });
    const saved = settings.save({ baseUrl: "https://api.example.com/v1/", apiKey: "sk-abcdef123456" });
    expect(saved).toMatchObject({ configured: true, source: "saved", keyHint: "…3456", protocol: "skills" });
    expect(JSON.stringify(saved)).not.toContain("sk-abcdef123456");
    expect(settings.read().baseUrl).toBe("https://api.example.com/v1");
    const reopened = createMediaSettings({ file: target, env: {} });
    expect(reopened.read()).toMatchObject({ configured: true, source: "saved" });
    expect(reopened.env()).toEqual({ baseUrl: "https://api.example.com/v1", apiKey: "sk-abcdef123456", protocol: "skills" });
    expect(settings.clear()).toMatchObject({ configured: false, source: "none" });
    expect(fs.existsSync(target)).toBe(false);
  });
  it("persists the protocol and reuses the saved key when the field is left blank", () => {
    const target = file(), settings = createMediaSettings({ file: target, env: {} });
    settings.save({ baseUrl: "https://api.example.com/v1", apiKey: "sk-abcdef123456" });
    const saved = settings.save({ baseUrl: "https://api.example.com/v1", protocol: "openai-images" });
    expect(saved).toMatchObject({ protocol: "openai-images", configured: true });
    expect(settings.env()).toEqual({ baseUrl: "https://api.example.com/v1", apiKey: "sk-abcdef123456", protocol: "openai-images" });
    const reopened = createMediaSettings({ file: target, env: {} });
    expect(reopened.read().protocol).toBe("openai-images");
    expect(JSON.stringify(reopened.read())).not.toContain("sk-abcdef123456");
    expect(() => createMediaSettings({ file: file(), env: {} }).save({ baseUrl: "https://api.example.com", protocol: "skills" })).toThrow(/API Key/);
    expect(() => settings.save({ baseUrl: "https://evil.example.com", protocol: "skills" })).toThrow(/重新填写 API Key/);
    expect(settings.save({ baseUrl: "https://api.example.com/v2" }).protocol).toBe("openai-images");
  });
  it("falls back to environment credentials without a saved file", () => {
    const settings = createMediaSettings({ env: { GLINT_MEDIA_BASE_URL: "https://env.example.com", GLINT_MEDIA_API_KEY: "sk-env12345" } });
    expect(settings.read()).toMatchObject({ configured: true, source: "environment", baseUrl: "https://env.example.com" });
  });
  it("rejects insecure or credential-bearing URLs and weak keys", () => {
    const settings = createMediaSettings({ file: file(), env: {} });
    for (const value of [
      { baseUrl: "http://api.example.com", apiKey: "sk-abcdef12" },
      { baseUrl: "https://user:pass@api.example.com", apiKey: "sk-abcdef12" },
      { baseUrl: "https://api.example.com?x=1", apiKey: "sk-abcdef12" },
      { baseUrl: "not-a-url", apiKey: "sk-abcdef12" },
      { baseUrl: "https://api.example.com", apiKey: "short" },
      { baseUrl: "", apiKey: "sk-abcdef12" },
      { baseUrl: "https://127.0.0.1", apiKey: "sk-abcdef12" },
      { baseUrl: "https://192.168.1.10", apiKey: "sk-abcdef12" },
    ]) expect(() => settings.save(value)).toThrow();
  });
});
