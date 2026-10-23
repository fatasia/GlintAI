import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
import { runMediaProcess } from "../../studio/scripts/native-process";
// @ts-expect-error JavaScript server exercised through real HTTP.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

/** Opt-in: real FFmpeg cut detection, real thumbnail install, real project mapping. */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-reference-e2e-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it.skipIf(process.env.GLINT_REFERENCE_E2E !== "1")("cuts a library video into an editable project with installed frames", async () => {
  const mediaDir = path.join(root, "media"), sessionsDir = path.join(root, "sessions");
  fs.mkdirSync(mediaDir, { recursive: true });
  const video = path.join(mediaDir, "ref.mp4");
  await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error",
    "-f", "lavfi", "-i", "color=c=red:s=160x90:r=20:d=1",
    "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=20:d=1",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "mpeg4", "-q:v", "2", video]);
  const server = createWebServer({ mediaJobs: createMediaJobs(mediaDir, {}), sessionStore: new FileSessionStore(sessionsDir, document => { parseProject(document); }) }) as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/api/reference/build`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ref.mp4" }) });
    const body = await response.json();
    expect(response.status, JSON.stringify(body).slice(0, 300)).toBe(200);
    expect(body.inferred).toBe(true);
    expect(body.shots).toBe(2);
    const project = parseProject(body.project);
    expect(project.scenes).toHaveLength(2);
    for (const scene of project.scenes) {
      const name = scene.src.slice("assets/".length);
      expect(name).toMatch(/^ref-[a-f0-9]{8}-00[12]\.jpg$/);
      expect(fs.statSync(path.join(mediaDir, name)).size).toBeGreaterThan(100);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 120_000);
