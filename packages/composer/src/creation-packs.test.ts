import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProject, type AspectRatio } from "@glintai/scenescript";
import { getCreationPack, instantiateCreationPack, listCreationPacks, previewCreationPack } from "./creation-packs";

const options = { projectId: "test-project" };
afterEach(() => vi.unstubAllGlobals());

describe("creation pack discovery", () => {
  it("exposes one JSON-only catalog of versioned results with explicit empty permissions", () => {
    const packs = listCreationPacks();
    expect(packs.map(pack => pack.id)).toEqual(["product-launch", "brand-quote", "data-insight", "how-to"]);
    expect(JSON.parse(JSON.stringify(packs))).toEqual(packs);
    for (const pack of packs) {
      expect(pack).toMatchObject({ author: "Glint", license: "Apache-2.0", version: "1.0.0", permissions: [] });
      expect(pack.title).toBeTruthy();
      expect(pack.description).toBeTruthy();
      expect(pack.tags.length).toBeGreaterThan(0);
      expect(new Set(pack.inputs.map(slot => slot.id)).size).toBe(pack.inputs.length);
      for (const slot of pack.inputs) {
        expect(slot).toEqual({ id: expect.any(String), label: expect.any(String), required: expect.any(Boolean), defaultValue: expect.any(String), maxLength: expect.any(Number) });
        expect(slot.defaultValue.length).toBeLessThanOrEqual(slot.maxLength);
      }
    }
  });

  it("searches title, description, id and tags with whitespace/case-insensitive AND terms", () => {
    expect(listCreationPacks("  PRODUCT-LAUNCH  ").map(pack => pack.id)).toEqual(["product-launch"]);
    expect(listCreationPacks("数据").map(pack => pack.id)).toEqual(["data-insight"]);
    expect(listCreationPacks("图表 报告").map(pack => pack.id)).toEqual(["data-insight"]);
    expect(listCreationPacks("关键帧").map(pack => pack.id)).toEqual(["brand-quote"]);
    expect(listCreationPacks("1.0.0")).toHaveLength(4);
    expect(listCreationPacks("   ")).toHaveLength(4);
    expect(listCreationPacks("不存在")).toEqual([]);
    expect(getCreationPack("__proto__")).toBeUndefined();
    expect(getCreationPack("missing")).toBeUndefined();
  });

  it("returns independent nested copies; catalog edits cannot change pinned projects or future output", () => {
    const existing = instantiateCreationPack("product-launch", {}, options);
    const snapshot = JSON.stringify(existing);
    const pack = getCreationPack("product-launch")!;
    pack.version = "99.0.0";
    pack.inputs[0]!.defaultValue = "污染";
    pack.preview.projectId = "changed";
    (pack.tags as string[]).push("changed");
    (pack.permissions as string[]).push("network");
    (pack.capabilities as string[]).push("execute");
    listCreationPacks().splice(0, 4);
    expect(getCreationPack("product-launch")).toMatchObject({ version: "1.0.0", permissions: [], preview: { projectId: "preview-product-launch" } });
    expect(getCreationPack("product-launch")!.tags).not.toContain("changed");
    expect(instantiateCreationPack("product-launch", {}, options)).toEqual(existing);
    expect(JSON.stringify(existing)).toBe(snapshot);
    existing.project.scenes[0]!.narration.text = "edited";
    existing.inputs.productName = "edited";
    existing.pack.version = "2.0.0";
    expect(instantiateCreationPack("product-launch", {}, options).project.scenes[0]!.narration.text).not.toBe("edited");
  });
});

describe("creation pack materialization", () => {
  it.each(listCreationPacks().map(pack => [pack.id]))("%s defaults preview exactly matches metadata and roundtrips through SceneScript", id => {
    const pack = getCreationPack(id!)!;
    const preview = previewCreationPack(id!);
    expect(preview).toEqual(instantiateCreationPack(id!, {}, { projectId: pack.preview.projectId }).project);
    expect(previewCreationPack(id!)).toEqual(preview);
    expect(preview.id).toBe(`preview-${id}`);
    expect(preview.aspect).toBe(pack.preview.aspect);
    expect(preview.scenes).toHaveLength(pack.preview.sceneCount);
    expect(preview.scenes.reduce((sum, scene) => sum + scene.narration.durationMs!, 0)).toBe(pack.preview.durationMs);
    expect(parseProject(JSON.parse(JSON.stringify(preview)))).toEqual(preview);
    expect(preview.creationPack).toEqual({ id, version: pack.version });
    expect(preview.knowledgeSources).toEqual([]);
    expect(preview.music).toBeUndefined();
    expect(preview.assets).toBeUndefined();
    for (const scene of preview.scenes) {
      expect(["title", "bullets", "comparison", "chart"]).toContain(scene.kind);
      expect(scene).not.toHaveProperty("src");
      expect(scene).not.toHaveProperty("html");
      expect(scene.narration.audioRef).toBeUndefined();
    }
  });

  it("creates unique IDs with browser crypto, not node imports or time/random fallbacks", () => {
    const a = instantiateCreationPack("product-launch", {});
    const b = instantiateCreationPack("product-launch", {});
    expect(a.project.id).toMatch(/^pack-[a-f0-9-]{36}$/);
    expect(a.project.id).not.toBe(b.project.id);
    const randomUUID = vi.fn(() => "00000000-0000-4000-8000-000000000001");
    vi.stubGlobal("crypto", { randomUUID });
    expect(instantiateCreationPack("product-launch", {}).project.id).toBe("pack-00000000-0000-4000-8000-000000000001");
    expect(randomUUID).toHaveBeenCalledOnce();
    vi.stubGlobal("crypto", undefined);
    expect(() => instantiateCreationPack("product-launch", {})).toThrow("crypto.randomUUID");
    expect(instantiateCreationPack("product-launch", {}, options).project.id).toBe(options.projectId);
  });

  it.each<AspectRatio>(["16:9", "9:16", "1:1"])("supports %s without changing text or receipt", aspect => {
    const result = instantiateCreationPack("product-launch", { productName: "  我的产品  " }, { ...options, aspect });
    expect(result.project.aspect).toBe(aspect);
    expect(result.project.title).toBe("我的产品");
    expect(result.inputs.productName).toBe("我的产品");
    expect(result.pack).toEqual(result.project.creationPack);
  });

  it("produces deterministic output for the same inputs, ID and aspect, preserving literal special text", () => {
    const values = { productName: "  <script> & 中文 🚀  ", tagline: "文字，不是可执行代码" };
    const before = { ...values };
    const result = instantiateCreationPack("product-launch", values, options);
    expect(instantiateCreationPack("product-launch", values, options)).toEqual(result);
    expect(values).toEqual(before);
    expect(result.project.scenes[0]).toMatchObject({ kind: "title", title: "<script> & 中文 🚀" });
  });

  it("has exactly twelve seconds and omits price cleanly unless explicitly provided", () => {
    const noPrice = instantiateCreationPack("product-launch", {}, options);
    expect(noPrice.project.scenes.reduce((sum, scene) => sum + scene.narration.durationMs!, 0)).toBe(12000);
    expect(noPrice.inputs.price).toBe("");
    expect(noPrice.project.scenes.at(-1)).not.toHaveProperty("subtitle");
    expect(instantiateCreationPack("product-launch", { price: "   " }, options)).toEqual(noPrice);
    const priced = instantiateCreationPack("product-launch", { price: "  ¥99 起  " }, options);
    expect(priced.project.scenes.at(-1)).toMatchObject({ subtitle: "¥99 起" });
  });

  it("keeps brand text and its native animation independently editable", () => {
    const project = instantiateCreationPack("brand-quote", { quote: "认真做好每一件事", brandName: "小店" }, options).project;
    expect(project.scenes[0]).toMatchObject({ title: "认真做好每一件事", subtitle: "小店", elements: [{ id: "brand-rule", kind: "rect" }], tracks: [{ elementId: "brand-rule", property: "scale" }] });
    expect(project.scenes[0]!.tracks![0]!.keyframes).toEqual([{ atMs: 0, value: 0 }, { atMs: 900, value: 1, easing: "ease-out" }]);
  });

  it("uses only supplied numeric facts, without fabricated insights or evidence", () => {
    const result = instantiateCreationPack("data-insight", { heading: "两组测量", label1: "甲", value1: " -12.5 ", label2: "乙", value2: "+0.25", unit: "kg" }, options);
    expect(result.project.scenes[0]).toMatchObject({ chartType: "bar", data: [{ label: "甲", value: -12.5 }, { label: "乙", value: 0.25 }], unit: "kg" });
    expect(result.inputs.value1).toBe("-12.5");
    expect(JSON.stringify(result.project)).not.toMatch(/增长|提升|因果|趋势/);
    expect(result.project.knowledgeSources).toEqual([]);
    expect(instantiateCreationPack("data-insight", { value1: "1000000000000", value2: "-1000000000000" }, options).project.scenes[0]).toMatchObject({ data: [{ value: 1e12 }, { value: -1e12 }] });
  });
});

describe("creation pack input trust boundary", () => {
  it("validates every slot required/length/type boundary", () => {
    for (const pack of listCreationPacks()) {
      for (const slot of pack.inputs) {
        if (slot.required) expect(() => instantiateCreationPack(pack.id, { [slot.id]: " \n " }, options)).toThrow("请填写");
        expect(() => instantiateCreationPack(pack.id, { [slot.id]: "x".repeat(slot.maxLength + 1) }, options)).toThrow("最多");
        expect(() => instantiateCreationPack(pack.id, { [slot.id]: 42 } as unknown as Record<string, string>, options)).toThrow("必须是文本");
        const text = slot.id.startsWith("value") ? "1".padStart(slot.maxLength, "0") : "字".repeat(slot.maxLength);
        expect(instantiateCreationPack(pack.id, { [slot.id]: text }, options).inputs[slot.id]).toBe(text);
      }
    }
  });

  it.each(["NaN", "Infinity", "-Infinity", "1e3", "0x10", "12kg", "1,200", "1_000", "1 2", "1000000000001", "-1000000000001", "1.2.3"])("rejects invalid number %s rather than coercing or silently defaulting", value => {
    for (const slot of ["value1", "value2"]) {
      expect(() => instantiateCreationPack("data-insight", { [slot]: value }, options)).toThrow("有限十进制数");
    }
  });

  it.each(["1000000000000.00001", "0.10000000000000001", "123456789.123456789"])("rejects precision loss for %s rather than silently changing a supplied fact", value1 => {
    expect(() => instantiateCreationPack("data-insight", { value1 }, options)).toThrow("精度");
  });

  it.each(["0", "-0", ".5", "+.25", "00012.5000", "0.000000000000000000000001"])("accepts exact equivalent decimal representation %s", value1 => {
    const scene = instantiateCreationPack("data-insight", { value1 }, options).project.scenes[0];
    expect(scene).toMatchObject({ data: [{ value: Number(value1) }, { value: 20 }] });
  });

  it("rejects unexpected/prototype keys, symbols, non-records and getters without invoking them", () => {
    const getter = vi.fn(() => "execute");
    const accessor = Object.defineProperty({}, "productName", { get: getter });
    const bad: unknown[] = [null, undefined, [], "text", new Date(), Object.create({ productName: "inherited" }), { unexpected: "x" }, { constructor: "x" }, { prototype: "x" }, JSON.parse('{"__proto__":"x"}'), { [Symbol("x")]: "x" }, accessor];
    for (const values of bad) expect(() => instantiateCreationPack("product-launch", values as Record<string, string>, options)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const clean = Object.assign(Object.create(null), { productName: "无原型对象" });
    expect(instantiateCreationPack("product-launch", clean, options).inputs.productName).toBe("无原型对象");
    expect(Object.prototype).not.toHaveProperty("productName");
  });

  it.each(["", "../project", "https://host", "UPPER", "has space", "-invalid", "a".repeat(121)])("rejects invalid project ID %s", projectId => {
    expect(() => instantiateCreationPack("product-launch", {}, { projectId })).toThrow("projectId");
  });

  it("rejects unknown packs, invalid aspect and invalid IDs even from untyped callers", () => {
    expect(() => instantiateCreationPack("missing", {}, options)).toThrow("未找到创作包");
    expect(() => previewCreationPack("missing")).toThrow("未找到创作包");
    expect(() => instantiateCreationPack("product-launch", {}, { ...options, aspect: "4:3" as AspectRatio })).toThrow();
    expect(() => instantiateCreationPack("product-launch", {}, { projectId: null } as unknown as typeof options)).toThrow("projectId");
  });
});
