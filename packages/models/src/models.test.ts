import { describe, expect, it } from "vitest";
import { builtinRegistry, checkBudget, createRegistry, parseRegistryJson, quote, RegistryError, selectModels, type ModelEntryInput } from "./index";

const image = (over: Partial<ModelEntryInput> = {}): ModelEntryInput => ({ id: "cloud-image", name: "云端文生图", provider: "my-gateway", kind: "image", capabilities: ["text-to-image"], pricing: { basis: "per-image", amountCny: 0.2 }, adapter: { type: "openai-images", model: "image-model-x" }, ...over });
const video = (over: Partial<ModelEntryInput> = {}): ModelEntryInput => ({ id: "cloud-video", name: "云端视频", provider: "my-gateway", kind: "video", capabilities: ["text-to-video", "first-frame"], pricing: { basis: "per-second", amountCny: 0.5 }, limits: { maxDurationSec: 10, aspects: ["16:9", "9:16"] }, adapter: { type: "skills-gateway", model: "video-model-y" }, ...over });
const local = (over: Partial<ModelEntryInput> = {}): ModelEntryInput => ({ id: "comfy-image", name: "ComfyUI 文生图", provider: "本机", kind: "image", capabilities: ["text-to-image", "reference-image"], pricing: { basis: "free-local" }, adapter: { type: "comfyui", workflow: "portrait.json" }, ...over });

describe("registry", () => {
  it("accepts valid entries and fills defaults", () => {
    const registry = createRegistry([image()]);
    expect(registry.get("cloud-image")).toMatchObject({ source: "user", limits: {} });
    expect(registry.find("missing")).toBeUndefined();
  });

  it("rejects duplicates, unknown ids and malformed entries with the reason", () => {
    expect(() => createRegistry([image(), image()])).toThrow(/Duplicate model id "cloud-image"/);
    expect(() => createRegistry([]).get("nope")).toThrow(RegistryError);
    expect(() => createRegistry([image({ id: "Bad Id" })])).toThrow(/invalid/);
    expect(() => createRegistry([image({ capabilities: ["text-to-image", "text-to-image"] })])).toThrow(/duplicate capability/);
    expect(() => createRegistry([image({ pricing: { basis: "per-image", amountCny: -1 } })])).toThrow(/invalid/);
  });

  it("enforces adapter rules: remote needs a model name, comfyui needs a workflow, free-local needs a local adapter", () => {
    expect(() => createRegistry([image({ adapter: { type: "openai-images" } })])).toThrow(/needs the model name/);
    expect(() => createRegistry([local({ adapter: { type: "comfyui" } })])).toThrow(/needs the workflow/);
    expect(() => createRegistry([image({ pricing: { basis: "free-local" } })])).toThrow(/only valid for a local adapter/);
  });

  it("filters by kind and required capabilities", () => {
    const registry = createRegistry([image(), video(), local()]);
    expect(registry.list({ kind: "image" }).map(e => e.id)).toEqual(["cloud-image", "comfy-image"]);
    expect(registry.list({ kind: "image", requires: ["text-to-image", "reference-image"] }).map(e => e.id)).toEqual(["comfy-image"]);
    expect(registry.list({ capability: "first-frame" }).map(e => e.id)).toEqual(["cloud-video"]);
  });

  it("with() and without() return new registries and leave the original alone", () => {
    const base = createRegistry([image()]);
    const more = base.with(video());
    expect(base.entries).toHaveLength(1);
    expect(more.entries).toHaveLength(2);
    expect(more.without("cloud-image").entries.map(e => e.id)).toEqual(["cloud-video"]);
    expect(() => base.without("nope")).toThrow(/Unknown model/);
  });

  it("parses a registry file and refuses oversize or malformed input", () => {
    expect(parseRegistryJson(JSON.stringify({ models: [image()] })).entries).toHaveLength(1);
    expect(() => parseRegistryJson("{not json")).toThrow(/not valid JSON/);
    expect(() => parseRegistryJson("{}")).toThrow(/"models" array/);
    expect(() => parseRegistryJson(" ".repeat(600 * 1024))).toThrow(/larger than/);
  });

  it("ships only local builtin entries, with no invented prices", () => {
    const builtin = builtinRegistry();
    expect(builtin.entries.length).toBeGreaterThan(0);
    expect(builtin.entries.every(e => e.pricing.basis === "free-local" && e.source === "builtin")).toBe(true);
  });
});

describe("quote", () => {
  const registry = createRegistry([image(), video(), local(), image({ id: "no-price", pricing: { basis: "unknown" } }), image({ id: "tts", kind: "speech", pricing: { basis: "per-1k-chars", amountCny: 0.3 }, capabilities: ["text-to-speech"] }), image({ id: "flat", pricing: { basis: "per-call", amountCny: 1.5 } })]);

  it("computes each pricing basis with its arithmetic", () => {
    expect(quote(registry.get("cloud-image"), { images: 12 })).toMatchObject({ costCny: 2.4, explain: "12 张 × ¥0.2" });
    expect(quote(registry.get("cloud-video"), { seconds: 7 })).toMatchObject({ costCny: 3.5 });
    expect(quote(registry.get("tts"), { chars: 2500 })).toMatchObject({ costCny: 0.75 });
    expect(quote(registry.get("flat"), { calls: 3 })).toMatchObject({ costCny: 4.5 });
    expect(quote(registry.get("comfy-image"), { images: 99 })).toMatchObject({ costCny: 0 });
  });

  it("never turns an unknown price into zero", () => {
    expect(quote(registry.get("no-price"), { images: 5 }).costCny).toBeNull();
  });

  it("avoids floating point drift", () => {
    expect(quote(registry.get("cloud-image"), { images: 3 }).costCny).toBe(0.6);
  });
});

describe("budget", () => {
  const registry = createRegistry([image(), image({ id: "no-price", pricing: { basis: "unknown" } })]);
  const line = (id: string, images: number) => ({ label: id, quote: quote(registry.get(id), { images }) });

  it("passes within the cap", () => {
    expect(checkBudget([line("cloud-image", 10)], { capCny: 5 })).toMatchObject({ ok: true, knownCny: 2 });
  });

  it("blocks over the cap", () => {
    expect(checkBudget([line("cloud-image", 100)], { capCny: 5 })).toMatchObject({ ok: false, reason: "over-budget", knownCny: 20 });
  });

  it("blocks an unknown price unless explicitly allowed", () => {
    const lines = [line("cloud-image", 1), line("no-price", 1)];
    expect(checkBudget(lines)).toMatchObject({ ok: false, reason: "unknown-cost", unknown: ["no-price"] });
    expect(checkBudget(lines, { allowUnknown: true }).ok).toBe(true);
  });

  it("reports over-budget before unknown when both apply", () => {
    expect(checkBudget([line("cloud-image", 100), line("no-price", 1)], { capCny: 1 }).reason).toBe("over-budget");
  });
});

describe("selection", () => {
  const registry = createRegistry([
    image({ id: "cheap-cloud", pricing: { basis: "per-image", amountCny: 0.05 } }),
    image({ id: "pricey-cloud", pricing: { basis: "per-image", amountCny: 0.9 } }),
    image({ id: "mystery", pricing: { basis: "unknown" } }),
    local(),
    video(),
    video({ id: "long-video", limits: { maxDurationSec: 30, aspects: ["16:9"] }, pricing: { basis: "per-second", amountCny: 1 } }),
  ]);

  it("ranks local first when preferred, then by known cost, unknown last", () => {
    const { ranked } = selectModels(registry, { kind: "image", usage: { images: 10 }, preferLocal: true });
    expect(ranked.map(r => r.entry.id)).toEqual(["comfy-image", "cheap-cloud", "pricey-cloud", "mystery"]);
  });

  it("is deterministic for the same registry and requirement", () => {
    const a = selectModels(registry, { kind: "image", usage: { images: 4 } }).ranked.map(r => r.entry.id);
    const b = selectModels(registry, { kind: "image", usage: { images: 4 } }).ranked.map(r => r.entry.id);
    expect(a).toEqual(b);
  });

  it("explains every rejection", () => {
    const { ranked, rejected } = selectModels(registry, { kind: "image", requires: ["reference-image"], usage: { images: 1 } });
    expect(ranked.map(r => r.entry.id)).toEqual(["comfy-image"]);
    expect(rejected.find(r => r.id === "cheap-cloud")?.reason).toContain("reference-image");
  });

  it("rejects on aspect, duration and cost cap", () => {
    const vertical = selectModels(registry, { kind: "video", aspect: "9:16", usage: { seconds: 5 } });
    expect(vertical.ranked.map(r => r.entry.id)).toEqual(["cloud-video"]);
    expect(vertical.rejected[0]).toMatchObject({ id: "long-video" });
    const long = selectModels(registry, { kind: "video", durationSec: 20, usage: { seconds: 20 } });
    expect(long.ranked.map(r => r.entry.id)).toEqual(["long-video"]);
    expect(long.rejected[0]?.reason).toContain("单次最长 10 秒");
    const capped = selectModels(registry, { kind: "image", maxCostCny: 1, usage: { images: 10 } });
    expect(capped.rejected.map(r => r.id)).toEqual(["pricey-cloud"]);
  });

  it("returns nothing, with no error, when no model fits", () => {
    expect(selectModels(registry, { kind: "3d", usage: {} })).toEqual({ ranked: [], rejected: [] });
  });
});
