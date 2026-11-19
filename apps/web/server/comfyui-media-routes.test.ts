import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createMediaJobs } from "./media-jobs.mjs";
import { approveMediaInput } from "./media-execution-test-approval";
import { createModelRegistryStore } from "./model-registry-store.mjs";
import { createWebServer } from "./index.mjs";
let root: string, web: Server | undefined, upstream: Server, base: string, endpoint: string, submits: number, missingNodes: boolean;
const token = "fixture-local-service-token-longer-than-24";
const headers = { authorization: `Basic ${Buffer.from(`glint:${token}`).toString("base64")}`, "content-type": "application/json" };
const body = { requestId: "route1", confirmed: true, type: "image", workflow: { "1": { class_type: "Fixture", inputs: { text: "private-prompt" } } } };
beforeEach(async () => {
 root = fs.mkdtempSync(path.join(os.tmpdir(), "comfy-route-")); submits = 0; missingNodes = false;
 const file = path.join(root, "fixture.png"); execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:size=16x16", "-frames:v", "1", file], { windowsHide: true }); const bytes = fs.readFileSync(file); fs.unlinkSync(file);
 upstream = createServer(async (req, res) => {
  for await (const _chunk of req) { /* drain bounded fixture request */ }
  if (req.url === "/object_info/Fixture") res.end(JSON.stringify(missingNodes ? {} : { Fixture: { name: "Fixture", input: {}, output: [] } }));
  else if (req.url === "/prompt") { submits++; res.end('{"prompt_id":"p1"}'); }
  else if (req.url?.startsWith("/history/")) res.end(JSON.stringify({ p1: { status: { status_str: "success", completed: true }, outputs: { "1": { images: [{ filename: "image.png", subfolder: "", type: "output" }] } } } }));
  else if (req.url === "/queue") res.end('{"queue_pending":[],"queue_running":[]}');
  else if (req.url?.startsWith("/view?")) res.end(bytes);
  else { res.writeHead(404); res.end(); }
 });
 await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve)); endpoint = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
async function closeWeb() { if (web) { web.closeAllConnections(); await new Promise<void>(resolve => web!.close(() => resolve())); web = undefined; } }
afterEach(async () => { await closeWeb(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); });
async function start(configured = true) {
 web = createWebServer({ modelRegistryStore: createModelRegistryStore(path.join(root,"registry.json")), basePath: "/glint/", publicHost: "fixture.test", accessToken: token, authRequired: true, requestLogDir: path.join(root, "logs"), mediaJobs: createMediaJobs(path.join(root, "library"), configured ? { GLINT_COMFYUI_ENDPOINT: endpoint } : {}) });
 await new Promise<void>(resolve => web!.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${(web!.address() as AddressInfo).port}/glint`;
}
const get = (route: string) => fetch(base + route, { headers });
const post = (route: string, value: unknown, extra = {}) => fetch(base + route, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(value) });
it("inherits host auth/origin/basePath and never accepts browser endpoints or unconfirmed execution", async () => {
 await start();
 expect((await fetch(base + "/api/media/comfyui/config")).status).toBe(401);
 expect((await post("/api/media/comfyui/submit", body, { origin: "https://foreign.test" })).status).toBe(403);
 expect((await fetch(base.replace("/glint", "") + "/api/media/comfyui/config", { headers })).status).toBe(404);
 expect(await (await get("/api/media/comfyui/config")).json()).toEqual({ configured: true, endpoint, source: "environment" });
 for (const invalid of [{ ...body, confirmed: false }, { ...body, endpoint }, { ...body, path: "outside" }, JSON.parse(JSON.stringify(body).replace('"text":', '"__proto__":'))]) expect((await post("/api/media/comfyui/submit", invalid)).status).toBe(400);
 expect(submits).toBe(0);
 const huge = await post("/api/media/comfyui/submit", { ...body, extra: "x".repeat(3 * 1024 * 1024) }); expect(huge.status).toBe(413); expect(submits).toBe(0);
});
it("submits, explicitly imports to the same library, restores on restart and preserves old recovery/cancel routes", async () => {
 await start(); const approved = await approveMediaInput(base, body, {headers}); const submitted = await post("/api/media/comfyui/submit", approved); expect(submitted.status).toBe(202); const { taskId } = await submitted.json();
 expect(await (await get("/api/media/request/route1")).json()).toEqual({ taskId });
 const status = await (await get(`/api/media/comfyui/status/${taskId}`)).json(); expect(status).toMatchObject({ state: "success", outputs: [{ index: 0, name: "image.png" }] }); expect(JSON.stringify(status)).not.toContain("private-prompt");
 expect((await post(`/api/media/comfyui/import/${taskId}`, { outputIndex: 0, url: endpoint })).status).toBe(400);
 expect(await (await get("/api/media/library")).json()).toEqual({ assets: [] });
 const imported = await post(`/api/media/comfyui/import/${taskId}`, { outputIndex: 0 }); expect(imported.status).toBe(200); const receipt = await imported.json(); expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
 expect((await get(receipt.assetUrl)).status).toBe(200); expect((await (await get("/api/media/library")).json()).assets[0].name).toBe(receipt.assetName);
 expect(await (await post(`/api/media/cancel/${taskId}`, {})).json()).toEqual({ taskId, outcome: "not-queued" });
 await closeWeb(); await start();
 expect(await (await post(`/api/media/comfyui/import/${taskId}`, { outputIndex: 0 })).json()).toEqual(receipt);
 expect((await (await get(`/api/media/status/${taskId}`)).json()).assetUrl).toBe(receipt.assetUrl); expect(submits).toBe(1);
});
it("shows a disabled capability without guessing a service target", async () => {
 await start(false); expect(await (await get("/api/media/comfyui/config")).json()).toEqual({ configured: false, endpoint: null, source: "none" });
 expect((await post("/api/media/comfyui/submit", body)).status).toBe(503); expect(submits).toBe(0);
});
it("bootstraps saved settings before configured, persists across restart and enforces host guards", async () => {
 await start(false);
 expect((await post("/api/media/comfyui/config", { endpoint }, { origin: "https://foreign.test" })).status).toBe(403);
 expect((await fetch(base + "/api/media/comfyui/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint }) })).status).toBe(401);
 expect((await post("/api/media/comfyui/config", { endpoint, apiKey: "secret" })).status).toBe(400);
 expect((await post("/api/media/comfyui/config", { endpoint: "http://remote.test" })).status).toBe(400);
 expect((await post("/api/media/comfyui/config", { endpoint: "x".repeat(1024) })).status).toBe(413);
 expect(await (await post("/api/media/comfyui/config", { endpoint })).json()).toEqual({ configured: true, endpoint, source: "saved" });
 await closeWeb(); await start(false);
 expect(await (await get("/api/media/comfyui/config")).json()).toEqual({ configured: true, endpoint, source: "saved" });
 expect((await post("/api/media/comfyui/submit", await approveMediaInput(base, body, {headers}))).status).toBe(202);
 expect(await (await post("/api/media/comfyui/config", { endpoint: null })).json()).toEqual({ configured: false, endpoint: null, source: "none" });
 expect(submits).toBe(1);
});
it("returns bounded preflight results and explicit not-submitted errors through authenticated routes", async () => {
 await start(); const payload = { workflow: body.workflow, inputs: [] };
 const approved = await approveMediaInput(base, body, {headers});
 expect((await fetch(base + "/api/media/comfyui/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })).status).toBe(401);
 expect((await post("/api/media/comfyui/validate", payload, { origin: "https://foreign.test" })).status).toBe(403);
 missingNodes = true;
 const checked = await post("/api/media/comfyui/validate", payload); expect(checked.status).toBe(200);
 expect(await checked.json()).toEqual({ ok: false, checked: 1, available: [], missing: ["Fixture"], submitted: false });
 const denied = await post("/api/media/comfyui/submit", approved); expect(denied.status).toBe(422);
 const error = await denied.json(); expect(error).toMatchObject({ code: "missing-nodes", submitted: false, missing: ["Fixture"], checked: 1 }); expect(JSON.stringify(error)).not.toContain("private-prompt");
 expect(submits).toBe(0); expect(fs.readdirSync(path.join(root, "library")).filter(name => /^(request-|comfy-)/.test(name))).toEqual([]);
 missingNodes = false; expect((await post("/api/media/comfyui/submit", approved)).status).toBe(202); expect(submits).toBe(1);
});
