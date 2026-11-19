import { describe, expect, it } from "vitest";
import { parseProject } from "./parse";
import { executeAssetRegeneration, invalidationReport, scenesAffectedByAsset } from "./asset-invalidate";
import type { SceneScriptProject } from "./types";

const project = (): SceneScriptProject => ({
  schemaVersion: 1,
  id: "impact-demo",
  title: "影响面",
  aspect: "16:9",
  fps: 30,
  knowledgeSources: [],
  assets: [{ id: "hero", kind: "character", version: "1.0.0", name: "zhu" }],
  scenes: [
    { id: "a", kind: "title", title: "kai", narration: { text: "yi", durationMs: 1000 }, assetRefs: [{ assetId: "hero", version: "1.0.0" }] },
    { id: "b", kind: "title", title: "zhong", narration: { text: "er", durationMs: 1000 }, assetRefs: [{ assetId: "hero", version: "1.0.0" }] },
    { id: "c", kind: "title", title: "shou", narration: { text: "san", durationMs: 1000 } },
  ],
} as unknown as SceneScriptProject);

describe("TEAM-03 asset invalidation", () => {
  it("lists exactly the scenes pinning the asset", () => {
    expect(scenesAffectedByAsset(project(), "hero")).toEqual(["a", "b"]);
  });
  it("returns an empty list without throwing for an unknown asset", () => {
    expect(scenesAffectedByAsset(project(), "ghost")).toEqual([]);
  });
  it("builds a per-change report marking whether regeneration is needed", () => {
    const report = invalidationReport(project(), [{ assetId: "hero", newVersion: "1.1.0" }, { assetId: "ghost", newVersion: "1.0.0" }]);
    expect(report[0]).toMatchObject({ assetId: "hero", affectedSceneIds: ["a", "b"], needsRegeneration: true });
    expect(report[1]).toMatchObject({ assetId: "ghost", affectedSceneIds: [], needsRegeneration: false });
  });
});

/** TEAM-03 重算执行流的真实夹具：schema 门（parseProject）逐例把关。 */
const regenProject = (): SceneScriptProject => parseProject({
  schemaVersion: 1, id: "regen-demo", title: "重算", aspect: "16:9", knowledgeSources: [],
  assets: [
    { id: "hero", kind: "character", version: "1.0.0", name: "主角" },
    { id: "logo", kind: "brand", version: "2.0.0", name: "标识" },
  ],
  scenes: [
    { id: "a", kind: "title", title: "开", narration: { text: "一", durationMs: 1000 }, assetRefs: [{ assetId: "hero", version: "1.0.0" }] },
    { id: "b", kind: "title", title: "承", narration: { text: "二", durationMs: 1000 }, assetRefs: [{ assetId: "hero", version: "1.0.0" }, { assetId: "logo", version: "2.0.0" }] },
    { id: "c", kind: "title", title: "转", narration: { text: "三", durationMs: 1000 } },
  ],
});

describe("TEAM-03 regeneration execution flow", () => {
  it("regenerates exactly the listed scenes scene by scene, re-pins and bumps atomically", () => {
    const source = regenProject();
    const visited: string[] = [];
    const { project, receipt } = executeAssetRegeneration(source, { assetId: "hero", newVersion: "1.1.0" }, scene => {
      visited.push(scene.id);
      return { ...scene, kind: "title", title: `${scene.kind === "title" ? scene.title : ""}·重生成` };
    });
    expect(receipt).toMatchObject({ ok: true, assetId: "hero", fromVersion: "1.0.0", toVersion: "1.1.0", regeneratedSceneIds: ["a", "b"] });
    expect(visited).toEqual(["a", "b"]);
    parseProject(project); // 结果必须过 schema 门（pin==当前版本）
    expect(project.assets!.find(asset => asset.id === "hero")!.version).toBe("1.1.0");
    expect(project.assets!.find(asset => asset.id === "logo")!.version).toBe("2.0.0");
    expect(project.scenes[0]!.assetRefs![0]).toEqual({ assetId: "hero", version: "1.1.0" }); // 重 pin 由执行流负责
    expect(project.scenes[1]!.assetRefs).toEqual([{ assetId: "hero", version: "1.1.0" }, { assetId: "logo", version: "2.0.0" }]);
    expect(project.scenes[2]!.assetRefs).toBeUndefined(); // 未受影响场景不被触碰
    expect((project.scenes[2] as { title: string }).title).toBe("转");
  });

  it("rolls the whole change back when a scene fails mid-run", () => {
    const source = regenProject();
    const { project, receipt } = executeAssetRegeneration(source, { assetId: "hero", newVersion: "1.1.0" }, scene => {
      if (scene.id === "b") throw new Error("重生成器失败");
      return scene;
    });
    expect(receipt).toMatchObject({ ok: false, failedSceneId: "b", regeneratedSceneIds: ["a"] });
    expect(receipt.reason).toContain("重生成器失败");
    expect(JSON.stringify(project)).toBe(JSON.stringify(source)); // 原工程原样返回，无半新半旧 pin
    expect(project.assets!.find(asset => asset.id === "hero")!.version).toBe("1.0.0");
  });

  it("keeps the project untouched when a regenerated scene fails the schema gate", () => {
    const source = regenProject();
    const { project, receipt } = executeAssetRegeneration(source, { assetId: "hero", newVersion: "1.1.0" }, scene => ({ ...scene, narration: undefined }) as unknown as SceneScriptProject["scenes"][number]);
    expect(receipt.ok).toBe(false);
    expect(receipt.reason).toContain("Invalid SceneScript project");
    expect(JSON.stringify(project)).toBe(JSON.stringify(source));
  });

  it.each(["character", "product", "brand"] as const)("rejects changed references or scene ids for %s and rolls back", kind => {
    const source = regenProject();
    source.assets![0]!.kind = kind;
    const before = structuredClone(source);
    for (const mutation of [
      (scene: SceneScriptProject["scenes"][number]) => ({ ...scene, assetRefs: [] }),
      (scene: SceneScriptProject["scenes"][number]) => ({ ...scene, assetRefs: [{ assetId: "logo", version: "2.0.0" }] }),
      (scene: SceneScriptProject["scenes"][number]) => ({ ...scene, assetRefs: scene.assetRefs!.map(ref => ref.assetId === "hero" ? { ...ref, version: "1.1.0" } : ref) }),
      (scene: SceneScriptProject["scenes"][number]) => ({ ...scene, assetRefs: [...scene.assetRefs!].reverse() }),
      (scene: SceneScriptProject["scenes"][number]) => ({ ...scene, id: "replacement" }),
    ]) {
      const result = executeAssetRegeneration(source, { assetId: "hero", newVersion: "1.1.0" }, scene => scene.id === "b" ? mutation(scene) : scene);
      expect(result.receipt).toMatchObject({ ok: false, failedSceneId: "b", regeneratedSceneIds: ["a"], reason: expect.stringContaining("scene identity or asset references") });
      expect(result.project).toEqual(before);
      expect(source).toEqual(before);
    }
  });

  it("preserves unrelated locked scenes and allows content edits with unchanged pins", () => {
    const base = regenProject();
    const source = parseProject({ ...base, scenes: base.scenes.map(scene => scene.id === "c" ? { ...scene, locked: true } : scene) });
    const result = executeAssetRegeneration(source, { assetId: "hero", newVersion: "1.1.0" }, scene => ({ ...scene, narration: { ...scene.narration, text: "新内容" } }));
    expect(result.receipt).toMatchObject({ ok: true, regeneratedSceneIds: ["a", "b"] });
    expect(result.project.scenes[2]).toEqual(source.scenes[2]);
    expect(result.project.scenes[1]!.assetRefs).toEqual([{ assetId: "hero", version: "1.1.0" }, { assetId: "logo", version: "2.0.0" }]);
    expect(source).toEqual(parseProject({ ...base, scenes: base.scenes.map(scene => scene.id === "c" ? { ...scene, locked: true } : scene) }));
  });

  it("refuses frozen projects, locked affected scenes and approved identities before running the callback", () => {
    const base = regenProject();
    const character = { id: "hero", kind: "character", version: "1.0.0", name: "主角", description: "蓝衣", voice: "voice-a", refs: ["assets/hero.png"] } as const;
    const product = { ...character, kind: "product", voice: undefined } as const;
    for (const source of [
      parseProject({ ...base, frozen: true }),
      parseProject({ ...base, scenes: base.scenes.map(scene => scene.id === "b" ? { ...scene, locked: true } : scene) }),
      ...[character, product].map(asset => parseProject({ ...base, assets: [{ ...asset, approval: { name: asset.name, version: asset.version, description: asset.description, ...(asset.voice ? { voice: asset.voice } : {}), refs: asset.refs } }, base.assets![1]] })),
    ]) {
      let calls = 0;
      const before = structuredClone(source);
      const result = executeAssetRegeneration(source, { assetId: "hero", newVersion: "1.1.0" }, scene => { calls++; return scene; });
      expect(result.receipt).toMatchObject({ ok: false, regeneratedSceneIds: [] });
      expect(calls).toBe(0);
      expect(result.project).toEqual(before);
      expect(source).toEqual(before);
    }
  });

  it("refuses unknown assets and no-ops when the version already matches", () => {
    const source = regenProject();
    let calls = 0;
    const missing = executeAssetRegeneration(source, { assetId: "ghost", newVersion: "1.0.0" }, scene => { calls += 1; return scene; });
    expect(missing.receipt).toMatchObject({ ok: false, reason: expect.stringContaining("unknown asset") });
    const settled = executeAssetRegeneration(source, { assetId: "hero", newVersion: "1.0.0" }, scene => { calls += 1; return scene; });
    expect(settled.receipt).toMatchObject({ ok: true, regeneratedSceneIds: [] });
    expect(calls).toBe(0);
    expect(JSON.stringify(settled.project)).toBe(JSON.stringify(source));
  });
});
