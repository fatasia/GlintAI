import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWebServer } from "./index.mjs";

const roots: string[] = [], servers: ReturnType<typeof createWebServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function start() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-design-route-")); roots.push(root);
  const file = "design-00000000-0000-4000-8000-000000000000.html";
  const run = vi.fn(async input => { fs.writeFileSync(path.join(root, file), "<h1>设计</h1>"); return { file, bytes: 16, path: path.join(root, file), warnings: [], editableElements: 3 }; });
  const server = createWebServer({ designExporter: { run }, designExportDir: root }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, run, root, file };
}
it("exports a design, keeps filesystem paths private and downloads as an attachment", async () => {
  const { url, run, file } = await start();
  const response = await fetch(`${url}/api/design/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document: { id: "sample" }, format: "html" }) });
  expect(response.status).toBe(200);
  const result = await response.json(); expect(result).toEqual({ file, bytes: 16, warnings: [], editableElements: 3 });
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ format: "html", document: { id: "sample" }, signal: expect.any(AbortSignal) }));
  const download = await fetch(`${url}/api/design/exports/${file}`);
  expect(download.headers.get("content-disposition")).toContain("attachment");
  expect(download.headers.get("content-security-policy")).toContain("sandbox");
  expect(await download.text()).toBe("<h1>设计</h1>");
  expect((await fetch(`${url}/api/design/exports/${file}`, { method: "HEAD" })).status).toBe(200);
});
it("rejects wrong methods, foreign origins, missing files and linked output files", async () => {
  const { url, root, file } = await start();
  expect((await fetch(`${url}/api/design/export`)).status).toBe(405);
  expect((await fetch(`${url}/api/design/export`, { method: "POST", headers: { origin: "https://other.example" }, body: "{}" })).status).toBe(403);
  expect((await fetch(`${url}/api/design/exports/${file}`)).status).toBe(404);
  fs.mkdirSync(path.join(root, "private"));
  fs.symlinkSync(path.join(root, "private"), path.join(root, file), "junction");
  expect((await fetch(`${url}/api/design/exports/${file}`)).status).toBe(404);
  expect((await fetch(`${url}/api/design/exports/invalid.html`)).status).toBe(404);
});
