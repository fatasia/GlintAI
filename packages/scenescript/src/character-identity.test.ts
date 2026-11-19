import { describe, expect, it } from "vitest";
import { approveCharacterIdentity, bindCharacterToScene, forkCharacterIdentity, upgradeCharacterScene, parseProject, saveCharacterIdentity, type AssetIdentity } from "./index";

const project = parseProject({ schemaVersion: 1, id: "drama", title: "短剧", aspect: "16:9", knowledgeSources: [], scenes: [
  { id: "one", kind: "title", title: "开场", narration: { text: "台词", voice: "old" } },
  { id: "two", kind: "title", title: "下一镜", narration: { text: "另一段" } },
] });
const hero: AssetIdentity = { id: "hero", kind: "character", name: "小雨", version: "v1", description: "短发、蓝色外套", voice: "voice-a", refs: ["assets/hero.png"] };

describe("approved character identity", () => {
  it("saves a draft, approves a frozen snapshot, and binds only the selected scene", () => {
    const draft = saveCharacterIdentity(project, hero), approved = approveCharacterIdentity(draft, "hero");
    expect(approved.assets![0]!.approval).toMatchObject({ name: "小雨", version: "v1", description: "短发、蓝色外套", voice: "voice-a", refs: ["assets/hero.png"] });
    const bound = bindCharacterToScene(approved, "one", "hero");
    expect(bound.scenes[0]).toMatchObject({ assetRefs: [{ assetId: "hero", version: "v1" }], narration: { text: "台词", voice: "voice-a" } });
    expect(bound.scenes[1]).toEqual(project.scenes[1]); expect(project.assets).toBeUndefined();
    expect(parseProject(JSON.parse(JSON.stringify(bound)))).toEqual(bound);
  });
  it("rejects incomplete approval and missing, locked or unapproved targets", () => {
    expect(() => approveCharacterIdentity(saveCharacterIdentity(project, { ...hero, voice: undefined }), "hero")).toThrow(/音色/);
    expect(() => approveCharacterIdentity(saveCharacterIdentity(project, { ...hero, refs: ["assets/voice.wav"] }), "hero")).toThrow(/参考图片/);
    expect(() => bindCharacterToScene(saveCharacterIdentity(project, hero), "one", "hero")).toThrow(/批准/);
    const approved = approveCharacterIdentity(saveCharacterIdentity(project, hero), "hero");
    expect(() => bindCharacterToScene(parseProject({ ...approved, scenes: [{ ...approved.scenes[0]!, locked: true }, approved.scenes[1]!] }), "one", "hero")).toThrow(/锁定/);
    expect(() => bindCharacterToScene(approved, "missing", "hero")).toThrow(/镜头/);
    const bound = bindCharacterToScene(approved, "one", "hero"); expect(() => bindCharacterToScene(bound, "one", "hero")).toThrow(/已绑定/);
  });
  it("refuses changes to approved fields, snapshot and versions with referenced scenes", () => {
    const approved = approveCharacterIdentity(saveCharacterIdentity(project, hero), "hero");
    expect(() => saveCharacterIdentity(approved, { ...hero, description: "different" })).toThrow(/已批准/);
    expect(() => parseProject({ ...approved, assets: [{ ...approved.assets![0]!, voice: "other" }] })).toThrow(/snapshot/);
    expect(() => parseProject({ ...approved, assets: [{ ...approved.assets![0]!, refs: ["assets/other.png"] }] })).toThrow(/snapshot/);
    expect(() => parseProject({ ...approved, assets: [{ ...approved.assets![0]!, description: " ", approval: { ...approved.assets![0]!.approval!, description: " " } }] })).toThrow(/blank/);
    expect(() => parseProject({ ...approved, assets: [{ ...approved.assets![0]!, refs: ["assets/audio.wav"], approval: { ...approved.assets![0]!.approval!, refs: ["assets/audio.wav"] } }] })).toThrow(/image/);
    const draft = saveCharacterIdentity(project, hero);
    const referenced = parseProject({ ...draft, scenes: [{ ...draft.scenes[0]!, assetRefs: [{ assetId: "hero", version: "v1" }] }, draft.scenes[1]!] });
    expect(() => saveCharacterIdentity(referenced, { ...hero, version: "v2" })).toThrow(/不能直接变更版本/);
    expect(() => approveCharacterIdentity({ ...draft, frozen: true }, "hero")).toThrow(/冻结/);
  });
});


it("forks an approved legacy version without changing old bindings, then explicitly upgrades one shot", () => {
  const old = bindCharacterToScene(approveCharacterIdentity(saveCharacterIdentity(project, hero), "hero"), "one", "hero");
  const fork = forkCharacterIdentity(old, "hero", "hero-next");
  expect(fork.assets![0]).toEqual(old.assets![0]); expect(fork.scenes).toEqual(old.scenes);
  expect(fork.assets![1]).toMatchObject({ id: "hero-next", version: "v1-next", derivedFrom: { assetId: "hero", version: "v1" } });
  expect(fork.assets![1]!.approval).toBeUndefined();
  const approved = approveCharacterIdentity(fork, "hero-next"), updated = upgradeCharacterScene(approved, "one", "hero-next");
  expect(updated.scenes[0]!.assetRefs).toEqual([{ assetId: "hero-next", version: "v1-next" }]);
  expect(updated.scenes[1]).toEqual(old.scenes[1]); expect(updated.assets![0]).toEqual(old.assets![0]);
  expect(() => upgradeCharacterScene(approved, "two", "hero-next")).toThrow(/未绑定/);
  expect(() => upgradeCharacterScene(parseProject({ ...approved, scenes: [{ ...approved.scenes[0]!, locked: true }, approved.scenes[1]!] }), "one", "hero-next")).toThrow(/未锁定/);
});
