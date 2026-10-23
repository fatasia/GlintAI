import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { runCreationPacks } from "./creation-packs-cli";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it("uses the shared pack core to create a pinned editable project without overwriting", () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-pack-cli-")); roots.push(root);
  const output = path.join(root, "project.json"), params = path.join(root, "inputs.json");
  fs.writeFileSync(params, JSON.stringify({ productName: "真实商品", price: "¥99" }));
  runCreationPacks(["--use=product-launch", `--out=${output}`, `--params=${params}`]);
  const original = fs.readFileSync(output, "utf8"), project = parseProject(JSON.parse(original));
  expect(project.creationPack).toEqual({ id: "product-launch", version: "1.0.0" });
  expect(original).toContain("真实商品"); expect(project.scenes.length).toBe(3);
  expect(() => runCreationPacks(["--use=product-launch", `--out=${output}`])).toThrow(/already exists/);
  expect(fs.readFileSync(output, "utf8")).toBe(original);
  fs.writeFileSync(params, JSON.stringify({ notAValidSlot: "bad" }));
  expect(() => runCreationPacks(["--use=product-launch", `--out=${path.join(root, "bad.json")}`, `--params=${params}`])).toThrow();
  expect(fs.existsSync(path.join(root, "bad.json"))).toBe(false);
});
it("materializes the same third-party data pack available to the software", () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-import-cli-")); roots.push(root);
  const source = path.join(root, "pack.json"), output = path.join(root, "project.json");
  fs.writeFileSync(source, JSON.stringify({ format: "glint-creation-pack", version: 1, id: "community", packVersion: "1.2.3", title: "Community", description: "Data only", author: "Independent", license: "MIT", tags: [],
    project: { schemaVersion: 1, id: "recipe", title: "Source", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "Imported", narration: { text: "Imported", durationMs: 1000 } }] } }));
  runCreationPacks([`--source=${source}`, `--out=${output}`]);
  const project = parseProject(JSON.parse(fs.readFileSync(output, "utf8")));
  expect(project.creationPack).toEqual({ id: "community", version: "1.2.3" });
  expect(project.scenes[0]!.kind).toBe("title"); expect(project.id).not.toBe("recipe");
  expect(() => runCreationPacks([`--source=${source}`, "--use=product-launch", `--out=${output}`])).toThrow(/not both/);
});
it("exports an edited project for Skill reuse with explicit rights and no private notes", () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-export-cli-")); roots.push(root);
  const projectFile = path.join(root, "project.json"), packFile = path.join(root, "saved-pack.json"), result = path.join(root, "result.json");
  fs.writeFileSync(projectFile, JSON.stringify({ schemaVersion: 1, id: "edited", title: "Edited", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "My edited title", notes: "PRIVATE_NOTES", narration: { text: "Hello", durationMs: 1000 } }] }));
  const args = [`--export-project=${projectFile}`, `--out=${packFile}`, "--author=Creator", "--license=Personal only"];
  expect(() => runCreationPacks(args)).toThrow(/confirm-rights/);
  expect(fs.existsSync(packFile)).toBe(false);
  runCreationPacks([...args, "--confirm-rights"]);
  const packText = fs.readFileSync(packFile, "utf8"); expect(packText).not.toContain("PRIVATE_NOTES");
  runCreationPacks([`--source=${packFile}`, `--out=${result}`]);
  expect(parseProject(JSON.parse(fs.readFileSync(result, "utf8"))).scenes[0]).toMatchObject({ title: "My edited title" });
  expect(() => runCreationPacks([...args, "--confirm-rights"])).toThrow();
});
it("exposes one searchable catalog without executing packages", () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const result = runCreationPacks([]);
  expect("packs" in result ? result.packs?.length : 0).toBeGreaterThanOrEqual(3);
  expect(() => runCreationPacks(["--use=../script", "--out=unused.json"])).toThrow();
});
