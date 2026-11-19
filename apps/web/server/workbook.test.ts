import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createWorkbook, createTypedWorkbook } from "./workbook-fixture";

let root: string;
let savedEnv: NodeJS.ProcessEnv;
let createWebServer: (options: Record<string, unknown>) => Server;
let sentinel: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-workbook-isolated-"));
  savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("GLINT_") || key === "INIT_CWD") delete process.env[key];
  const temp = path.join(root, "temp"), studio = path.join(root, "studio");
  fs.mkdirSync(temp, { recursive: true });
  const jobs = path.join(studio, "out", ".jobs"); fs.mkdirSync(jobs, { recursive: true });
  sentinel = path.join(jobs, "idea-isolation-sentinel.json");
  fs.writeFileSync(sentinel, JSON.stringify({ id: "idea-isolation-sentinel", createdAt: 1, finishedAt: 1, log: [], status: "done" }));
  Object.assign(process.env, {
    GLINT_DATA_DIR: path.join(root, "data"), GLINT_SESSION_DIR: path.join(root, "sessions"),
    GLINT_CACHE_DIR: path.join(root, "cache"), GLINT_STUDIO_DIR: studio,
    GLINT_STYLE_SAMPLE_DIR: path.join(root, "styles"), TEMP: temp, TMP: temp, TMPDIR: temp,
  });
  // The module creates stores during import, before createWebServer can receive overrides.
  vi.resetModules();
  // @ts-expect-error JavaScript server exercised through HTTP.
  ({ createWebServer } = await import("./index.mjs"));
});

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function isolatedServer(name: string) {
  const dir = path.join(root, name); fs.mkdirSync(dir);
  const makeRunner = new Proxy({}, { get: () => { throw new Error("Workbook tests must not invoke the make runner"); } });
  const server = createWebServer({ makeRunner, requestLogDir: path.join(dir, "logs"), composeCacheDir: path.join(dir, "compose-cache"), ttsCacheDir: path.join(dir, "tts") });
  return { dir, server };
}

it("reads a real XLSX over HTTP, rejects invalid files and deletes temporary data", async () => {
  const { dir, server } = isolatedServer("basic"), file = path.join(dir, "two.xlsx"); createWorkbook(file);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/source/workbook`;
    const post = (base64: string) => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ base64 }) });
    const temp = path.join(root, "temp");
    expect(os.tmpdir()).toBe(temp);
    const response = await post(fs.readFileSync(file).toString("base64")); expect(response.status).toBe(200);
    const data = await response.json(); expect(data.sheets).toHaveLength(2); expect(data.sheets[0].text).toContain("季度1,10"); expect(data.sheets[1].text).toContain("季度2,20");
    expect((await post(Buffer.from("invalid").toString("base64"))).status).toBe(400);
    const formula = path.join(dir, "uncalculated.xlsx"); createWorkbook(formula, true);
    const rejected = await post(fs.readFileSync(formula).toString("base64")); expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toContain("缓存公式值");
    expect(fs.readdirSync(temp).filter(name => name.startsWith("glint-workbook-"))).toEqual([]);
    expect(fs.readFileSync(sentinel, "utf8")).toContain('"createdAt":1');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30000);

it("preserves XLSX booleans, cached text, date systems and fractional-day times", async () => {
  const { dir, server } = isolatedServer("types");
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/source/workbook`;
    for (const use1904 of [false, true]) {
      const file = path.join(dir, `typed-${use1904}.xlsx`); createTypedWorkbook(file, use1904);
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ base64: fs.readFileSync(file).toString("base64") }) });
      expect(response.status).toBe(200);
      const text = (await response.json()).sheets[0].text;
      expect(text).toContain(use1904 ? "1904-01-02,1904-02-29,1904-03-01,1904-03-02T12:00:00.000" : "1900-01-01,1900-02-28,1900-02-29,1900-03-01T12:00:00.000");
      expect(text).toContain("TRUE,FALSE,label");
    }
    expect(fs.readdirSync(path.join(root, "temp")).filter(name => name.startsWith("glint-workbook-"))).toEqual([]);
    expect(fs.readFileSync(sentinel, "utf8")).toContain('"createdAt":1');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30000);
