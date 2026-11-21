// Portions derived from OpenMotion (nexu-io/openmotion), Apache-2.0. Modifications: content sourced from Glint's own recipes instead of the upstream catalog.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { validateCatalog } from "@glintai/composer/template-catalog";
import { runCatalogCli } from "./template-catalog-cli";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it("imports the real recipe catalog into the OpenMotion-shaped directory and passes its own check", () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-catalog-import-")); roots.push(root);
  const out = path.join(root, "catalog");
  runCatalogCli([`--out=${out}`], "import");
  // 127 = 100 条 recipe-catalog 配方 + 5 个创作包 + 12 个结构模板 + 10 个风格包。
  const report = validateCatalog(out);
  expect(report).toMatchObject({ ok: true, problems: [] });
  expect(report.entryCount).toBe(100 + 5 + 12 + 10);
  const index = JSON.parse(fs.readFileSync(path.join(out, "catalog.json"), "utf8"));
  expect(index.counts).toEqual({ recipe: 105, structure: 12, style: 10 });
  expect(fs.existsSync(path.join(out, "recipe-product-launch-dark-tech", "cover.png"))).toBe(true);
  runCatalogCli([`--dir=${out}`], "check");
  expect(process.exitCode).toBeUndefined();
  expect(() => runCatalogCli([`--out=${out}`], "import")).toThrow(/已存在/);
});

it("fails with a non-zero exit code when the catalog is tampered with", () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-catalog-check-")); roots.push(root);
  const out = path.join(root, "catalog");
  runCatalogCli([`--out=${out}`], "import");
  const entry = path.join(out, "recipe-product-launch-dark-tech", "template.json");
  const data = JSON.parse(fs.readFileSync(entry, "utf8"));
  fs.writeFileSync(entry, JSON.stringify({ ...data, params: [] }, null, 2));
  runCatalogCli([`--dir=${out}`], "check");
  expect(process.exitCode).toBe(1);
  process.exitCode = undefined;
  expect(() => runCatalogCli([], "check")).toThrow(/--dir=/);
  expect(() => runCatalogCli([`--dir=${path.join(root, "missing")}`], "check")).toThrow(/目录不存在/);
});
