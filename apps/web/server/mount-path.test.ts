import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
// @ts-expect-error JavaScript HTTP service.
import { createWebServer } from "./index.mjs";

it("mounts static files and API under one prefix without claiming other application routes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"glint-mount-test-"));
  fs.writeFileSync(path.join(root,"index.html"),"<main>Mounted Glint</main>");
  fs.writeFileSync(path.join(root,"icon.svg"),'<svg xmlns="http://www.w3.org/2000/svg"/>');
  const server = createWebServer({basePath:"/glint/",distDir:root}) as Server;
  try {
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const redirect = await fetch(`${origin}/glint?x=1`,{redirect:"manual"});
    expect(redirect.status).toBe(308); expect(redirect.headers.get("location")).toBe("/glint/?x=1");
    expect(await (await fetch(`${origin}/glint/`)).text()).toContain("Mounted Glint");
    expect((await fetch(`${origin}/glint/icon.svg`)).headers.get("content-type")).toContain("image/svg+xml");
    expect((await (await fetch(`${origin}/glint/api/health`)).json()).service).toBe("glint-web");
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    for (const url of ["/", "/api/health", "/icon.svg", "/glint-other/api/health", "/glint/../api/health"])
      expect((await fetch(origin+url)).status,url).toBe(404);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
it("refuses ambiguous mount configuration", () => {
  for (const basePath of ["glint", "/glint", "//", "/../", "/a%2fb/", "https://example.com/"])
    expect(()=>createWebServer({basePath})).toThrow("GLINT_WEB_BASE_PATH");
});
