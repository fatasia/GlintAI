import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it, vi } from "vitest";
// @ts-expect-error JavaScript server exercised via actual HTTP.
import { createWebServer } from "./index.mjs";

it("rejects executable scenes at every Web render entry before calling an exporter", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-web-policy-"));
  const projectExporter = vi.fn(async () => ({ file: "example.png" }));
  const nleExporter = vi.fn(async () => ({ file: "example.fcpxml" }));
  const server = createWebServer({ projectExporter, nleExporter, requestLogDir: path.join(root, "logs") }) as Server;
  const baseProject = { schemaVersion: 1, id: "boundary", title: "边界", aspect: "16:9", knowledgeSources: [] };
  const narration = { text: "边界场景" };
  const prohibited = [
    { id: "html", kind: "html", html: "<p>x</p>", animation: "gsap", narration },
    { id: "three", kind: "three", model: "icosahedron", narration },
    { id: "gltf", kind: "three", model: "gltf", src: "assets/model.glb", narration },
  ];
  const allowed = { id: "title", kind: "title", title: "正常标题", narration };
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const [route, format] of [["/api/project/export", "png"], ["/api/project/export", "gif"], ["/api/project/nle", "fcpxml"], ["/api/project/nle", "edl"]]) {
      for (const scene of prohibited) {
        const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format, project: { ...baseProject, scenes: [allowed, scene] } }) });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain("glint render");
      }
    }
    expect(projectExporter).not.toHaveBeenCalled(); expect(nleExporter).not.toHaveBeenCalled();
    for (const [route, format] of [["/api/project/export", "png"], ["/api/project/export", "gif"], ["/api/project/nle", "fcpxml"], ["/api/project/nle", "edl"]]) {
      const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format, project: { ...baseProject, scenes: [allowed] } }) });
      expect(response.status).toBe(200);
    }
    expect(projectExporter).toHaveBeenCalledTimes(2); expect(nleExporter).toHaveBeenCalledTimes(2);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
