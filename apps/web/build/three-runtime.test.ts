import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { build, createServer } from "vite";
import { expect, it } from "vitest";
import { threeRuntime } from "./three-runtime";
import { buildThreeRuntime } from "../../studio/scripts/decoders";

it("emits and serves the same executable Three runtime without a pre-staged public file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "glint-three-web-"));
  const server = await createServer({
    configFile: false,
    root,
    plugins: [threeRuntime()],
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await fs.writeFile(path.join(root, "index.html"), "<!doctype html><title>runtime</title>");
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    const response = await fetch(`http://127.0.0.1:${address.port}/three.runtime.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    const actual = new Uint8Array(await response.arrayBuffer());
    expect(actual).toEqual(await buildThreeRuntime());
    const result = await build({
      configFile: false,
      root,
      plugins: [threeRuntime()],
      logLevel: "silent",
      build: { write: false, minify: false },
    });
    if (Array.isArray(result) || !("output" in result)) throw new Error("Unexpected build output");
    const runtime = result.output.find((item) => item.fileName === "three.runtime.js");
    if (!runtime || runtime.type !== "asset") throw new Error("Runtime asset missing");
    expect(runtime.source).toEqual(actual);
    const context = { AbortController, window: {} as { THREE?: { Scene?: unknown } } };
    vm.runInNewContext(Buffer.from(actual).toString("utf8"), context);
    expect(typeof context.window.THREE?.Scene).toBe("function");
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
