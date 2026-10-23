import { describe, expect, it } from "vitest";
import { installImportedPack, readImportedPacks, removeImportedPack, replaceImportedPack } from "./imported-pack-store";
const pack = () => ({ format: "glint-creation-pack", version: 1, id: "community", packVersion: "1.0.0", title: "社区配方", description: "本地数据配方", author: "Author", license: "MIT", tags: ["字卡"], permissions: [], project: { schemaVersion: 1, id: "source", title: "Source", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "Hello", narration: { text: "Hello", durationMs: 1000 } }] } });
const storage = () => {
  let value: string | null = null;
  return { getItem: (_key: string) => value, setItem: (_key: string, next: string) => { value = next; } };
};
describe("data-only installed pack store", () => {
  it("installs, survives a read and removes without changing original input", () => {
    const local = storage(), source = pack(), before = JSON.stringify(source);
    expect(readImportedPacks(local)).toEqual([]);
    expect(installImportedPack(source, local)).toHaveLength(1);
    expect(readImportedPacks(local)[0]!.title).toBe("社区配方");
    expect(() => installImportedPack(source, local)).toThrow(/已存在/);
    expect(removeImportedPack("community", local)).toEqual([]);
    expect(readImportedPacks(local)).toEqual([]); expect(JSON.stringify(source)).toBe(before);
  });
  it("refuses malformed stored data, executable packs and quota failures instead of claiming success", () => {
    for (const raw of ["{", "null", "{}", "x".repeat(1_000_001)]) expect(() => readImportedPacks({ getItem: () => raw })).toThrow();
    const local = storage();
    expect(() => installImportedPack({ ...pack(), permissions: ["execute"] }, local)).toThrow();
    expect(readImportedPacks(local)).toEqual([]);
    expect(() => installImportedPack(pack(), { getItem: () => null, setItem: () => { throw new Error("quota"); } })).toThrow("quota");
  });
  it("upgrades an existing id explicitly and never installs an unknown id through the replace path", () => {
    const local = storage(), v1 = pack();
    installImportedPack(v1, local);
    const v2 = { ...pack(), packVersion: "1.1.0", title: "社区配方 v2" };
    expect(replaceImportedPack(v2, local)).toHaveLength(1);
    expect(readImportedPacks(local)[0]).toMatchObject({ id: "community", packVersion: "1.1.0", title: "社区配方 v2" });
    expect(() => replaceImportedPack({ ...pack(), id: "unknown" }, local)).toThrow(/不在本机创作库/);
    expect(readImportedPacks(local)).toHaveLength(1);
  });
});
