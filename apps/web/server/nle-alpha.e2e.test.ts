import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { findSystemBrowser } from "../../studio/scripts/direct-browser/host";
let available = true; try { findSystemBrowser(); if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) available = false; } catch { available = false; }

it.skipIf(process.env.GLINT_NLE_ALPHA_E2E !== "1" || !available)("renders and downloads an actual transparent VP9 WebM through HTTP", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-alpha-http-"));
  const previous = process.env.GLINT_DATA_DIR; process.env.GLINT_DATA_DIR = root;
  // @ts-expect-error JavaScript server exercised via real HTTP.
  const { createWebServer } = await import("./index.mjs");
  const server = createWebServer() as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const project = { schemaVersion: 1, id: "alpha-http", title: "Alpha", fps: 10, width: 320, height: 180, tracks: [{ id: "t", kind: "text", name: "文字", clips: [{ id: "text", kind: "text", text: "ALPHA", startMs: 0, durationMs: 300 }] }] };
    const response = await fetch(`${base}/api/nle/render`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, alpha: true }) });
    const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200); expect(body.url).toMatch(/\.webm$/);
    const download = await fetch(base + body.url); expect(download.status).toBe(200); expect(download.headers.get("content-type")).toBe("video/webm");
    const file = path.join(root, "result.webm"); fs.writeFileSync(file, Buffer.from(await download.arrayBuffer()));
    const decoded = spawnSync("ffmpeg", ["-v", "error", "-c:v", "libvpx-vp9", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { maxBuffer: 2 * 1024 * 1024 });
    expect(decoded.status, decoded.stderr.toString()).toBe(0);
    const alpha: number[] = []; for (let i = 3; i < decoded.stdout.length; i += 4) alpha.push(decoded.stdout[i]!);
    expect(alpha.filter(value => value < 10).length).toBeGreaterThan(30000); expect(alpha.filter(value => value > 240).length).toBeGreaterThan(100);
    if (body.coverUrl) expect((await fetch(base + body.coverUrl)).status).toBe(200);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.GLINT_DATA_DIR; else process.env.GLINT_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
