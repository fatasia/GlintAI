import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { desktopServiceBuildOptions, portableChapterBuildOptions } from "./portable-service-build.mjs";
import { copyDesktopServiceDependencies } from "./portable-dependencies.mjs";

const repo = path.resolve(import.meta.dirname, "../../..");
const nonce = "desktop-bundle-test-0123456789";
it("bundles root and project-container contract exports together", async () => {
  const options = desktopServiceBuildOptions(repo, "contract-check.mjs");
  const { entryPoints: _entryPoints, ...shared } = options;
  const result = await build({ ...shared, write: false,
    stdin: { resolveDir: repo, contents: `
      import { parseProject } from "@glintai/scenescript";
      import { canonicalProjectJson } from "@glintai/scenescript/project-container";
      export const parserType = typeof parseProject;
      export const canonical = canonicalProjectJson({ b: 2, a: 1 });
    ` },
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-contract-bundle-"));
  try {
    const bundle = path.join(root, "contracts.mjs");
    fs.writeFileSync(bundle, result.outputFiles![0]!.text);
    const module = await import(/* @vite-ignore */ pathToFileURL(bundle).href);
    expect(module.parserType).toBe("function");
    expect(module.canonical).toBe('{"a":1,"b":2}');
  } finally { cleanup(root); }
});

function firstLine(child: ChildProcessWithoutNullStreams) {
  return new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Missing startup line")), 15000);
    child.stdout.on("data", chunk => {
      output += String(chunk);
      if (output.includes("\n")) { clearTimeout(timer); resolve(output.split("\n")[0]!); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); if (!output.includes("\n")) reject(new Error("Exited before startup")); });
  });
}
async function stop(child: ChildProcessWithoutNullStreams, graceful: boolean) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  if (graceful) { child.stdin.write(JSON.stringify({ type: "shutdown", nonce }) + "\n"); child.stdin.end(); }
  else child.kill();
  await closed;
}
function cleanup(root: string) {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unsafe temporary path");
  fs.rmSync(root, { recursive: true, force: true });
}

it("bundled desktop service sends readiness JSON first and serves health", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-bundle-test-"));
  const bundle = path.join(root, "service.mjs"), data = path.join(root, "data");
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const runtime = copyDesktopServiceDependencies(repo, root);
    expect(runtime).toEqual(expect.arrayContaining([expect.objectContaining({ name: "jsdom", version: "30.1.3" })]));
    await build(desktopServiceBuildOptions(repo, bundle));
    child = spawn(process.execPath, [bundle, `--data-dir=${data}`, `--nonce=${nonce}`], {
      cwd: root, windowsHide: true, stdio: "pipe",
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, GLINT_WEB_DIST: root, GLINT_STUDIO_DIR: root },
    });
    const message = JSON.parse(await firstLine(child));
    expect(message.type).toBe("ready"); expect(message.nonce).toBe(nonce);
    expect((await fetch(message.url + "/healthz")).status).toBe(200);
    // Exercise jsdom's real file-relative runtime after relocating out of the workspace.
    // No model credential is passed to this child; validation precedes the 503 provider gate.
    const response = await fetch(message.url + "/api/artifact/proposal", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "把标题改短", document: { id: "design", title: "测试", kind: "page", updatedAt: 1, activePageId: "page",
        pages: [{ id: "page", title: "首页", html: '<h1 data-design-id="title">标题</h1>' }] },
        selection: { documentId: "design", pageId: "page", nodeId: "title", nodeIds: ["title"], text: "标题" } }),
    });
    expect(response.status).toBe(503); expect((await response.json()).error).toContain("配置文本模型");
    await stop(child, true);
  } finally { if (child) await stop(child, false); cleanup(root); }
}, 30000);

it.runIf(process.platform === "win32")("bundled isolated adapter runs the copied release bridge", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-adapter-bundle-"));
  const bundle = path.join(root, "adapter.mjs"), executable = path.join(root, "glint-secure-assets.exe");
  const library = path.join(root, "library"); fs.mkdirSync(library);
  fs.copyFileSync(path.join(repo, "apps/desktop/secure-assets/target/release/glint-secure-assets.exe"), executable, fs.constants.COPYFILE_EXCL);
  await build(portableChapterBuildOptions(repo, bundle));
  const adapter = await import(/* @vite-ignore */ pathToFileURL(bundle).href);
  const store = await adapter.openSecureAssets(executable, library);
  try {
    await store.publish("asset.png", Buffer.from("original"));
    expect(await store.read("asset.png")).toEqual(Buffer.from("original"));
    await expect(store.publish("asset.png", Buffer.from("other"))).rejects.toMatchObject({ code: "EEXIST" });
    expect(fs.readFileSync(path.join(library, "asset.png"), "utf8")).toBe("original");
  } finally { await store.close(); }
  // Retain the isolated fixture, never delete an existing user path.
}, 30000);

it("regular web entry still starts on its configured host", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-web-entry-test-"));
  const loader = createRequire(path.join(repo, "apps/web/package.json")).resolve("tsx");
  const child = spawn(process.execPath, ["--import", pathToFileURL(loader).href, path.join(repo, "apps/web/server/index.mjs")], {
    cwd: root, windowsHide: true, stdio: "pipe",
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, GLINT_WEB_DIST: root, GLINT_STUDIO_DIR: root, GLINT_DATA_DIR: path.join(root, "data"), GLINT_HOST: "127.0.0.1", PORT: "0" },
  });
  try { expect(await firstLine(child)).toContain("[glint-web] serving"); }
  finally { await stop(child, false); cleanup(root); }
}, 30000);
