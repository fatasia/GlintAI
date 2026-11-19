import { expect, it } from "vitest";
import { projectMediaCatalog, supportsMediaCapability } from "./media-catalog";
import { quote } from "./quote";

it("projects only the existing executable catalog in original order with original remote identities", () => {
  const raw = [{ id: "Vendor/Edit.v2", name: "编辑", tags: ["图生图"], description: "catalog" }, { id: "plain", tags: [] }];
  const before = JSON.stringify(raw), projected = projectMediaCatalog(raw, "image", "skills");
  expect(projected.map(model => model.id)).toEqual(["Vendor/Edit.v2", "plain"]);
  expect(projected[0]).toMatchObject({ ...raw[0], registry: { capabilities: ["reference-image", "image-to-image"], adapter: { type: "skills-gateway", model: "Vendor/Edit.v2" }, pricing: { basis: "unknown" }, limits: {} } });
  expect(quote(projected[0]!.registry, { images: 1 }).costCny).toBeNull();
  expect(JSON.stringify(raw)).toBe(before);
});
it("grants only exact explicit tags and never trusts names or forged metadata", () => {
  for (const tags of [undefined, "图生图", {}, ["图生图", {}], ["reference"], ["图生图 "], Array(33).fill("图生图")]) {
    expect(supportsMediaCapability({ id: "image-to-image", tags, registry: { capabilities: ["reference-image"] } }, "skills", "reference-image")).toBe(false);
  }
  for (const tag of ["图片编辑", "图生图", "多图参考", "参考", "Image editing", "Image-to-image", "Multi-image reference", "Reference"]) {
    expect(supportsMediaCapability({ id: "edit", tags: [tag] }, "skills", "reference-image")).toBe(true);
  }
  expect(supportsMediaCapability({ id: "edit", tags: ["图片编辑"] }, "skills", "image-to-image")).toBe(false);
  expect(supportsMediaCapability({ id: "edit", tags: ["透明背景"] }, "skills", "transparent-background")).toBe(true);
});
it("does not grant reference capability to other protocols or media kinds", () => {
  const raw = [{ id: "edit", tags: ["图生图", "透明背景"] }];
  expect(projectMediaCatalog(raw, "video", "skills")[0]!.registry.capabilities).toEqual([]);
  expect(projectMediaCatalog(raw, "image", "openai-images")[0]!.registry.capabilities).toEqual([]);
  for (const protocol of ["fal", "replicate", "comfyui", "", "local-process"]) expect(projectMediaCatalog(raw, "image", protocol)).toEqual([]);
  expect(projectMediaCatalog(raw, "video", "openai-images")).toEqual([]);
});
it("rejects malformed and unavailable entries without inventing defaults", () => {
  expect(projectMediaCatalog([null, {}, { id: "" }, { id: "bad\n" }, { id: "a", available_for_this_key: false }, { id: "ok" }, { id: "ok" }], "image", "skills").map(model => model.id)).toEqual(["ok"]);
  expect(projectMediaCatalog(Array(501).fill({ id: "x" }), "image", "skills")).toEqual([]);
  expect(projectMediaCatalog({}, "image", "skills")).toEqual([]);
});

it("does not let a validity flag or precomputed capabilities widen raw declarations", () => {
  expect(supportsMediaCapability({ id: "edit", tags: ["图生图"], capabilityTagsValid: false }, "skills", "reference-image")).toBe(false);
  expect(supportsMediaCapability({ id: "edit", tags: ["图生图", {}], capabilityTagsValid: true }, "skills", "reference-image")).toBe(false);
});
