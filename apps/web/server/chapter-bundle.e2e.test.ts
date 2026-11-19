import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import http from "node:http";
import { expect, it } from "vitest";
import { parseProject } from "../../../packages/scenescript/src/parse";
import { exportPortableChapters, importPortableChapters } from "./portable-chapter-migration";
const isolationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "glint-chapter-server-"));
process.env.GLINT_DATA_DIR = path.join(isolationRoot, "data");
process.env.GLINT_SESSION_DIR = path.join(isolationRoot, "sessions");
process.env.GLINT_CACHE_DIR = path.join(isolationRoot, "cache");
// @ts-expect-error JavaScript server exercised over HTTP.
const { createWebServer } = await import("./index.mjs");
// @ts-expect-error JavaScript media library.
const { createMediaJobs } = await import("./media-jobs.mjs");
// The adapter is deliberately not mounted in production. The test server maps
// unpredictable test credentials to server-side sessions; it is not a production authenticator.
// @ts-expect-error JavaScript adapter under isolated test.
const { createPortableChapterHandler } = await import("./portable-chapter-route.mjs");
// @ts-expect-error JavaScript bridge under isolated test.
const { openSecureAssets } = await import("./secure-assets-bridge.mjs");
function isolatedMigrationServer(media: unknown, credentials: Map<string, string>, now = () => performance.now()) {
  const handlePortableChapter = createPortableChapterHandler({ resolveSession: (req: http.IncomingMessage) => credentials.get(req.headers.authorization ?? ""), isSessionActive: (session: string) => [...credentials.values()].includes(session), openAssetStore: (root: string) => openSecureAssets(path.resolve("apps/desktop/secure-assets/target/debug/glint-secure-assets.exe"), root), now });
  const server = createWebServer({ mediaJobs: media, portableChapterHandler: handlePortableChapter, requestLogDir: path.join(isolationRoot, "adapter-logs"), composeCacheDir: path.join(isolationRoot, "adapter-cache") });
  Object.assign(server, { closeBridge: () => handlePortableChapter.close() });
  return server;
}

it("retries failed and exited bridges, and closes a bridge that finishes opening during shutdown", async () => {
  let attempts = 0, alive = true, closes = 0;
  let release!: (store: unknown) => void;
  const delayed = new Promise(resolve => { release = resolve; });
  const store = () => ({ isUsable: () => alive, read: async () => Buffer.alloc(0), publish: async () => "", close: async () => { closes++; } });
  const handler = createPortableChapterHandler({
    resolveSession: () => "session", isSessionActive: () => true,
    openAssetStore: () => { attempts++; if (attempts === 1) throw new Error("startup failed"); if (attempts === 3) return delayed; return store(); },
  });
  const media = { portableChapterRoot: () => "isolated-root" };
  const server = http.createServer(async (req, res) => {
    const sendJson = (response: typeof res, status: number, payload: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(payload)); };
    await handler(req, res, new URL(req.url ?? "/", "http://localhost"), { media, sendJson });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chapters/export-bundle`;
  const post = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  try {
    expect((await post()).status).toBe(503);
    expect((await post()).status).toBe(400);
    alive = false;
    const pending = post();
    while (attempts < 3) await new Promise(resolve => setTimeout(resolve, 5));
    const closing = handler.close();
    alive = true;
    release(store());
    expect((await pending).status).toBe(503);
    await closing;
    expect(closes).toBe(2);
    expect((await post()).status).toBe(401);
    expect(attempts).toBe(3);
  } finally {
    await handler.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("rejects a stalled upload and releases the migration lock", async () => {
  const handler = createPortableChapterHandler({
    resolveSession: () => "session", isSessionActive: () => true, requestTimeoutMs: 100,
    openAssetStore: async () => ({ read: async () => Buffer.alloc(0), publish: async () => "", close: async () => {} }),
  });
  const media = { portableChapterRoot: () => "isolated-root" };
  const server = http.createServer(async (req, res) => {
    const sendJson = (response: typeof res, status: number, payload: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(payload)); };
    await handler(req, res, new URL(req.url ?? "/", "http://localhost"), { media, sendJson });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chapters/export-bundle`;
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(url, { method: "POST", headers: { "content-type": "application/json", "content-length": "100" } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode!)); });
      request.on("error", reject); request.write("{");
    });
    expect(status).toBe(503);
    expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status).toBe(400);
  } finally {
    server.closeAllConnections();
    await handler.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it.runIf(process.platform === "win32")("migrates full snapshots between genuinely isolated media libraries", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-chapter-isolation-"));
  const source = path.join(root, "machine-a"), target = path.join(root, "machine-b");
  const a = createMediaJobs(source, {}), b = createMediaJobs(target, {});
  expect(fs.realpathSync(source)).not.toBe(fs.realpathSync(target));
  const credentialA = randomBytes(32).toString("hex"), credentialB = randomBytes(32).toString("hex");
  const credentials = new Map([[credentialA, "session-a"], [credentialB, "session-b"]]);
  let clock = 0, expireAfterPrune = false, clockReads = 0;
  const now = () => { if (expireAfterPrune && ++clockReads === 2) clock += 300_000; return clock; };
  const servers: Server[] = [createWebServer({ mediaJobs: a, requestLogDir: path.join(root, "logs-a"), composeCacheDir: path.join(root, "cache-a") }), createWebServer({ mediaJobs: b, requestLogDir: path.join(root, "logs-b"), composeCacheDir: path.join(root, "cache-b") }), isolatedMigrationServer(a, credentials, now), isolatedMigrationServer(b, credentials, now)];
  const base = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const server of servers) await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    // A successful Host check is not an authenticated session or a filesystem boundary.
    // All production migration routes must remain unavailable even on loopback.
    for (const server of servers.slice(0, 2)) for (const action of ["export", "import", "preview", "commit"]) {
      const response = await fetch(`${base(server)}/api/chapters/${action}-bundle`, { method: "POST", headers: { "content-type": "application/json", authorization: credentialA }, body: "{}" });
      expect(response.status).toBe(503);
    }
    const fixture = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=16x16", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { windowsHide: true });
    expect(fixture.status, String(fixture.stderr)).toBe(0);
    const png = fixture.stdout;
    const uploaded = await fetch(`${base(servers[0]!)}/api/media/import-image`, { method: "POST", headers: { "content-type": "image/png" }, body: png });
    expect(uploaded.status).toBe(201);
    const { name } = await uploaded.json() as { name: string };
    expect(a.asset(name)).toBeTruthy();
    expect(b.asset(name)).toBeNull();
    const chapters = ["one", "two"].map((id, index) => ({
      title: `章节 ${id}`, updatedAt: 100 + index,
      context: { mode: "source" as const, text: `资料 ${id}`, template: "explainer", theme: "whiteboard", evidence: `依据 ${id}` },
      project: parseProject({ schemaVersion: 1, id, title: id, aspect: "16:9", knowledgeSources: [], scenes: [{ id: "cover", kind: "image", src: `assets/${name}`, narration: { text: id, durationMs: 1500 } }] }),
    }));
    const headers = { "content-type": "application/json", authorization: credentialA };
    const pendingExport = fetch(`${base(servers[2]!)}/api/chapters/export-bundle`, { method: "POST", headers, body: JSON.stringify({ chapters }) });
    await new Promise(resolve => setTimeout(resolve, 40));
    const parallel = await fetch(`${base(servers[2]!)}/api/chapters/export-bundle`, { method: "POST", headers, body: JSON.stringify({ chapters }) });
    expect(parallel.status).toBe(429);
    const exported = await pendingExport;
    expect(exported.status).toBe(200);
    const serialized = await exported.text();
    const post = (route: string, body: string, token?: string, credential = credentialA, server = servers[3]!) => fetch(`${base(server)}/api/chapters/${route}-bundle`, { method: "POST", headers: { "content-type": "application/json", authorization: credential, ...(token ? { "x-glint-confirm-import": token } : {}) }, body });
    const invalid = JSON.parse(serialized); invalid.chapters[1].assets[0].sha256 = "0".repeat(64);
    expect((await post("preview", JSON.stringify(invalid))).status).toBe(400);
    expect(fs.readdirSync(target)).toEqual([]);
    expect((await post("commit", serialized)).status).toBe(403);
    const digest = createHash("sha256").update(serialized).digest("hex");
    expect((await post("commit", serialized, digest)).status).toBe(403);
    expect((await post("preview", serialized, undefined, "unrecognized")).status).toBe(401);
    const malformedUtf8 = await fetch(`${base(servers[3]!)}/api/chapters/preview-bundle`, { method: "POST", headers, body: new Uint8Array([0x7b, 0xff, 0x7d]) });
    expect(malformedUtf8.status).toBe(400);
    expect((await malformedUtf8.json() as { error: string }).error).toContain("UTF-8");
    const oversized = await post("preview", "x".repeat(32 * 1024 * 1024 + 1));
    expect(oversized.status).toBe(413);
    const previewResponse = await post("preview", serialized);
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.headers.get("cache-control")).toBe("no-store");
    const preview = await previewResponse.json() as Awaited<ReturnType<typeof importPortableChapters>> & { token: string; expiresInMs: number };
    expect(preview.token).not.toBe(preview.importId);
    expect(preview.token).toMatch(/^[\w-]{43}$/);
    expect(fs.readdirSync(target)).toEqual([]);
    expect((await post("commit", serialized, preview.token, credentialB)).status).toBe(403);
    credentials.delete(credentialA);
    expect((await post("commit", serialized, preview.token)).status).toBe(401);
    credentials.set(credentialA, "session-a");
    expect((await post("commit", serialized + " ", preview.token)).status).toBe(403);
    expect((await post("commit", serialized, preview.token, credentialA, servers[2]!)).status).toBe(403);
    expect(fs.readdirSync(target)).toEqual([]);
    const committed = await post("commit", serialized, preview.token);
    expect(committed.status).toBe(200);
    const restored = await committed.json() as Awaited<ReturnType<typeof importPortableChapters>>;
    expect(restored).toEqual({ importId: preview.importId, chapters: preview.chapters });
    expect(restored.chapters.map(({ title, updatedAt, context }) => ({ title, updatedAt, context }))).toEqual(chapters.map(({ title, updatedAt, context }) => ({ title, updatedAt, context })));
    const ref = (restored.chapters[0]!.project.scenes[0] as { src: string }).src;
    expect((restored.chapters[1]!.project.scenes[0] as { src: string }).src).toBe(ref);
    expect(ref).toBe(`assets/chapter-${createHash("sha256").update(png).digest("hex")}.png`);
    const fetched = await fetch(`${base(servers[1]!)}/api/media/assets/${ref.slice(7)}`);
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(png);
    expect(await (await post("commit", serialized, preview.token)).json()).toEqual(restored);
    expect(fs.readdirSync(target)).toEqual([ref.slice(7)]);
    expect(fs.readdirSync(source)).toEqual([name]);
    const conflict = path.join(target, ref.slice(7)); fs.writeFileSync(conflict, "foreign");
    expect((await post("commit", serialized, preview.token)).status).toBe(400);
    expect(fs.readFileSync(conflict, "utf8")).toBe("foreign");
    fs.writeFileSync(conflict, png);
    expect(await (await post("commit", serialized, preview.token)).json()).toEqual(restored);
    clock += preview.expiresInMs;
    expect((await post("commit", serialized, preview.token)).status).toBe(403);
    const freshResponse = await post("preview", serialized);
    expect(freshResponse.status).toBe(200);
    const fresh = await freshResponse.json() as typeof preview;
    expect(fresh.token).not.toBe(preview.token);
    expect(await (await post("commit", serialized, fresh.token)).json()).toEqual(restored);
    const expiringResponse = await post("preview", serialized);
    expect(expiringResponse.status).toBe(200);
    const expiring = await expiringResponse.json() as typeof preview;
    const beforeExpiry = fs.readFileSync(conflict);
    clockReads = 0; expireAfterPrune = true;
    expect((await post("commit", serialized, expiring.token)).status).toBe(403);
    expireAfterPrune = false;
    expect((await post("commit", serialized, expiring.token)).status).toBe(403);
    expect(fs.readFileSync(conflict)).toEqual(beforeExpiry);
    expect(fs.readdirSync(target)).toEqual([ref.slice(7)]);
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await Promise.all(servers.slice(2).map(server => (server as Server & { closeBridge(): Promise<void> }).closeBridge()));
    // Keep this exclusively created fixture for inspection.
  }
}, 60_000);
