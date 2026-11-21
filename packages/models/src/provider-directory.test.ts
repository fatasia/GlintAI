import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS, providerPreset } from "./provider-directory";

describe("provider directory (P5, OpenMotion-shaped connection metadata)", () => {
  it("exposes the three media presets plus a compatible set, with no pricing or keys", () => {
    const ids = PROVIDER_PRESETS.map(preset => preset.id);
    expect(ids).toEqual(expect.arrayContaining(["fal", "atlascloud", "wavespeed", "openrouter", "ollama"]));
    expect(PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(10);
    for (const preset of PROVIDER_PRESETS) {
      expect(JSON.stringify(preset)).not.toMatch(/pricing|price|api[_-]?key":|sk-/i);
      if (preset.id !== "ollama") expect(preset.baseUrl).toMatch(/^https:\/\//);
      if (preset.keyEnvironment !== undefined) expect(preset.keyEnvironment).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
  it("keeps loopback HTTP as the only non-HTTPS exception", () => {
    expect(providerPreset("ollama")?.baseUrl).toBe("http://127.0.0.1:11434/v1");
    for (const preset of PROVIDER_PRESETS) {
      if (preset.id === "ollama") continue;
      expect(preset.baseUrl.startsWith("https://")).toBe(true);
    }
  });
  it("carries key environment names without values and points at the vendor console", () => {
    const fal = providerPreset("fal");
    expect(fal).toMatchObject({ keyEnvironment: "FAL_KEY", keyWebsite: "https://fal.ai/dashboard/keys", baseUrl: "https://queue.fal.run" });
    expect(Object.values(fal!).join(" ")).not.toMatch(/=.+[A-Za-z0-9]{20}/);
  });
  it("presets are immutable lookup data with a stable id shape", () => {
    expect(providerPreset("nonexistent")).toBeUndefined();
    for (const preset of PROVIDER_PRESETS) expect(preset.id).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
  });
});
