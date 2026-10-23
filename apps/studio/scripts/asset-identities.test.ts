import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProject } from "@glintai/scenescript";
import { assetReport } from "./asset-identities";

const roots: string[] = [];
function fixture(): { projectPath: string; projectDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-assets-test-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "assets"));
  fs.writeFileSync(path.join(root, "assets", "hero.png"), "png");
  const projectPath = path.join(root, "project.json");
  fs.writeFileSync(projectPath, JSON.stringify({
    schemaVersion: 1, id: "assets-report", title: "Assets", aspect: "16:9", knowledgeSources: [],
    assets: [
      { id: "hero", kind: "character", name: "主角", version: "v1", refs: ["assets/hero.png", "assets/missing.png"] },
      { id: "bottle", kind: "product", name: "商品", version: "v2" },
    ],
    scenes: [{ id: "one", kind: "title", title: "One", narration: { text: "a", durationMs: 500 }, assetRefs: [{ assetId: "hero", version: "v1" }] }],
  }, null, 2));
  return { projectPath, projectDir: root };
}
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

describe("asset report", () => {
  it("lists references, scenes, missing files and unreferenced identities", () => {
    const { projectPath, projectDir } = fixture();
    const report = assetReport(parseProject(JSON.parse(fs.readFileSync(projectPath, "utf8"))), projectDir);
    const hero = report.assets.find(asset => asset.id === "hero")!;
    expect(hero.scenes).toEqual(["one"]);
    expect(hero.refs).toEqual([{ path: "assets/hero.png", exists: true }, { path: "assets/missing.png", exists: false }]);
    expect(report.unreferenced).toEqual(["bottle"]);
    expect(report.ok).toBe(false);
  });
});
