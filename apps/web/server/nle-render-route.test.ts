import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
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
async function start() {
  server = createWebServer({
    nleVideoRenderer: render,
    publicHost: "fixture.test",
    accessToken: "local-fixture-token-long-enough",
    authRequired: true,
    basePath: "/glint/",
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
