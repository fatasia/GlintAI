import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWebServer } from "./index.mjs";
const project = {
  schemaVersion: 1,
  id: "motion-http",
  title: "Motion",
  fps: 10,
  width: 320,
  height: 180,
  tracks: [],
};
const render = vi.fn(async () => ({ file: "result.mp4", url: "/result.mp4", bytes: 100 }));
let server: Server;
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  render.mockClear();
});
async function start(overrides: Record<string, unknown> = {}) {
  server = createWebServer({
    nleVideoRenderer: render,
    publicHost: "fixture.test",
    accessToken: "local-fixture-token-long-enough",
    authRequired: true,
    basePath: "/glint/",
    ...overrides,
  }) as Server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function post(origin: string, body: unknown, originHeader = origin, authorized = true) {
  return fetch(origin + "/glint/api/nle/render", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: originHeader,
      ...(authorized
        ? {
            authorization:
              "Basic " + Buffer.from("glint:local-fixture-token-long-enough").toString("base64"),
          }
        : {}),
    },
    body: JSON.stringify(body),
  });
}
it("inherits real auth and Origin protection, then dispatches validated options once", async () => {
  const origin = await start(),
    body = { project, motionSamples: 4, shutterAngle: 270 };
  expect((await post(origin, body, origin, false)).status).toBe(401);
  expect((await post(origin, body, "https://foreign.invalid")).status).toBe(403);
  expect(render).not.toHaveBeenCalled();
  expect((await post(origin, body)).status).toBe(200);
  expect(render).toHaveBeenCalledTimes(1);
  expect(render).toHaveBeenCalledWith(expect.objectContaining(body));
});
it("rejects invalid values and over-budget projects before starting any worker", async () => {
  const origin = await start();
  for (const patch of [
    { motionSamples: 3 },
    { motionSamples: "4" },
    { shutterAngle: null },
    { shutterAngle: 0 },
    { motionSamples: 4, project: { ...project, width: 3840, height: 2160 } },
  ]) {
    expect((await post(origin, { project, ...patch })).status).toBe(400);
  }
  expect(render).not.toHaveBeenCalled();
  expect((await post(origin, { project: { ...project, width: 3840, height: 2160 } })).status).toBe(
    200,
  );
  expect(render).toHaveBeenCalledTimes(1);
  expect(render).toHaveBeenCalledWith(
    expect.objectContaining({ motionSamples: 1, shutterAngle: 180 }),
  );
});
it("preserves alpha preflight even with motion enabled", async () => {
  const origin = await start();
  const tracks = [
    {
      id: "v",
      kind: "video",
      name: "Visual",
      clips: [{ id: "c", kind: "video", src: "assets/video.mp4", startMs: 0, durationMs: 300 }],
    },
  ];
  const response = await post(origin, {
    project: { ...project, tracks },
    alpha: true,
    motionSamples: 2,
  });
  expect(response.status).toBe(400);
  expect((await response.json()).issues).toEqual([expect.objectContaining({ clipId: "c" })]);
  expect(render).not.toHaveBeenCalled();
  expect((await post(origin, { project, alpha: true, motionSamples: 2 })).status).toBe(200);
  expect(render).toHaveBeenCalledTimes(1);
  expect(render).toHaveBeenCalledWith(expect.objectContaining({ alpha: true, motionSamples: 2 }));
});

const audioAndVideoTracks = [
  {
    id: "v",
    kind: "video",
    name: "Visual",
    clips: [{ id: "c", kind: "video", src: "assets/video.mp4", startMs: 0, durationMs: 300 }],
  },
  {
    id: "a",
    kind: "audio",
    name: "Audio",
    clips: [{ id: "ca", kind: "audio", src: "assets/a.mp3", startMs: 0, durationMs: 400 }],
  },
];

it("attaches a controlled verify receipt, expects the render spec, and strips the artifact path", async () => {
  const artifact = path.join(os.tmpdir(), `nle-verify-route-${process.pid}.mp4`);
  fs.writeFileSync(artifact, "x");
  try {
    const verifier = vi.fn(async () => ({
      pass: true,
      sha256: "abc123",
      bytes: 100,
      duration: 0.4,
      checks: [
        { name: "input", pass: true, detail: "Local video, 100 bytes" },
        { name: "spec:width", pass: true, detail: "Expected width 320, got 320" },
      ],
      remainingChecks: ["打开成片完整观看一遍：画面内容、剪辑点与节奏未由本工具评估"],
    }));
    const origin = await start({
      nleVideoRenderer: vi.fn(async () => ({
        file: "r1.mp4",
        url: "/api/project/export/r1/r1.mp4",
        bytes: 100,
        outputPath: artifact,
      })),
      nleExportVerifier: verifier,
    });
    const response = await post(origin, { project: { ...project, tracks: audioAndVideoTracks } });
    expect(response.status).toBe(200);
    const data = await response.json();
    // Receipt keeps the download contract and gains a detail-free verify summary.
    expect(data.url).toBe("/api/project/export/r1/r1.mp4");
    expect(data.verify).toEqual({
      pass: true,
      sha256: "abc123",
      bytes: 100,
      duration: 0.4,
      checks: [{ name: "input", pass: true }, { name: "spec:width", pass: true }],
      remainingChecks: ["打开成片完整观看一遍：画面内容、剪辑点与节奏未由本工具评估"],
    });
    expect(JSON.stringify(data)).not.toContain(artifact);
    // Expectations derive from the render request; an audio clip demands an audio track.
    expect(verifier).toHaveBeenCalledWith(
      expect.objectContaining({
        videoPath: artifact,
        expect: { width: 320, height: 180, fps: 10, durationMs: 400 },
        audio: "required",
      }),
    );
  } finally {
    fs.rmSync(artifact, { force: true });
  }
});

it("keeps the download receipt intact when verification fails", async () => {
  const verifier = vi.fn(async () => ({
    pass: false,
    sha256: null,
    bytes: 0,
    checks: [
      { name: "input", pass: true, detail: "Local video, 7 bytes" },
      { name: "decode", pass: false, detail: "corrupt frame data" },
    ],
    remainingChecks: [],
  }));
  const origin = await start({
    nleVideoRenderer: vi.fn(async () => ({
      file: "r2.mp4",
      url: "/api/project/export/r2/r2.mp4",
      bytes: 7,
      outputPath: "Z:\\nowhere\\r2.mp4",
    })),
    nleExportVerifier: verifier,
  });
  const response = await post(origin, { project });
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data.url).toBe("/api/project/export/r2/r2.mp4");
  expect(data.bytes).toBe(7);
  expect(data.verify.pass).toBe(false);
  expect(data.verify.checks).toEqual([{ name: "input", pass: true }, { name: "decode", pass: false }]);
  expect(JSON.stringify(data)).not.toContain("corrupt frame data");
});

it("never echoes verifier crashes or local paths to the client", async () => {
  const verifier = vi.fn(async () => {
    throw new Error("ffprobe failed on D:\\secret\\renders\\r3.mp4");
  });
  const origin = await start({
    nleVideoRenderer: vi.fn(async () => ({
      file: "r3.mp4",
      url: "/api/project/export/r3/r3.mp4",
      bytes: 9,
      outputPath: "D:\\secret\\renders\\r3.mp4",
    })),
    nleExportVerifier: verifier,
  });
  const response = await post(origin, { project });
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data.verify).toEqual({
    pass: false,
    sha256: null,
    bytes: 0,
    checks: [],
    remainingChecks: [],
    error: "failed",
  });
  expect(JSON.stringify(data)).not.toContain("secret");
  expect(JSON.stringify(data)).not.toContain("ffprobe");
});
