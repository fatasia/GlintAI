import { describe, expect, it } from "vitest";
import { parseProject } from "./parse";

const base = {
  schemaVersion: 1, id: "assets-fixture", title: "Assets", aspect: "16:9", knowledgeSources: [],
  assets: [
    { id: "hero", kind: "character", name: "主角", version: "v1", refs: ["assets/hero.png"] },
    { id: "bottle", kind: "product", name: "商品", version: "v2" },
  ],
  scenes: [
    { id: "one", kind: "title", title: "One", narration: { text: "a", durationMs: 500 }, assetRefs: [{ assetId: "hero", version: "v1" }] },
  ],
};

describe("asset identity contract", () => {
  it("accepts a project whose scenes pin the current asset versions", () => {
    expect(parseProject(base).assets?.[0]?.id).toBe("hero");
  });
  it("rejects an unknown asset reference", () => {
    const broken = structuredClone(base);
    broken.scenes[0]!.assetRefs = [{ assetId: "ghost", version: "v1" }];
    expect(() => parseProject(broken)).toThrow(/unknown asset/);
  });
  it("rejects a stale version pin", () => {
    const broken = structuredClone(base);
    broken.scenes[0]!.assetRefs = [{ assetId: "bottle", version: "v1" }];
    expect(() => parseProject(broken)).toThrow(/version v2, scene pins v1/);
  });
  it("rejects duplicate asset ids and duplicate refs in one scene", () => {
    const duplicateAsset = structuredClone(base);
    duplicateAsset.assets.push({ id: "hero", kind: "brand", name: "重复", version: "v1" });
    expect(() => parseProject(duplicateAsset)).toThrow(/duplicate asset id/);
    const duplicateRef = structuredClone(base);
    duplicateRef.scenes[0]!.assetRefs = [{ assetId: "hero", version: "v1" }, { assetId: "hero", version: "v1" }];
    expect(() => parseProject(duplicateRef)).toThrow(/duplicate asset reference/);
  });
});
