import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createWebServer } from "./index.mjs";

it.skipIf(process.env.GLINT_TEST_REAL_STUDIO !== "1")("provides a runnable isolated studio when explicitly requested", () => {
  const studio = process.env.GLINT_STUDIO_DIR!;
  expect(path.resolve(studio)).not.toBe(path.resolve("apps/studio"));
  expect(fs.existsSync(path.join(studio, "scripts", "glint.ts"))).toBe(true);
  expect(fs.existsSync(path.join(studio, "package.json"))).toBe(true);
  expect(fs.existsSync(path.join(studio, "node_modules", "tsx"))).toBe(true);
  expect(fs.existsSync(path.join(studio, "out"))).toBe(false);
  const script = path.join(studio, "scripts", "glint.ts");
  expect(fs.realpathSync(script)).not.toBe(fs.realpathSync(path.resolve("apps/studio/scripts/glint.ts")));
});

it("isolates statically imported server stores and default runner recovery", () => {
  const data = process.env.GLINT_DATA_DIR!;
  const studio = process.env.GLINT_STUDIO_DIR!;
  const jobs = path.join(data, "jobs", ".jobs");
  const legacy = path.join(studio, "out", ".jobs");
  fs.mkdirSync(legacy, { recursive: true });
  const sentinel = path.join(legacy, "idea-sentinel.json");
  const record = JSON.stringify({ id: "idea-sentinel", createdAt: Date.now(), status: "running", log: [] });
  fs.writeFileSync(sentinel, record);
  expect(fs.existsSync(jobs)).toBe(false);
  createWebServer({ makeRunner: {} });
  expect(fs.existsSync(jobs)).toBe(false);
  fs.mkdirSync(jobs, { recursive: true });
  const isolatedRecord = path.join(jobs, "idea-isolated.json");
  fs.writeFileSync(isolatedRecord, JSON.stringify({ id: "idea-isolated", createdAt: Date.now(), status: "running", log: [] }));
  createWebServer();
  expect(JSON.parse(fs.readFileSync(isolatedRecord, "utf8")).stage).toBe("interrupted");
  expect(fs.readFileSync(sentinel, "utf8")).toBe(record);
});
