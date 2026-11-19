import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { copyRuntimeDecoders, ensureDecoders } from "../decoders";
import { findSystemBrowser } from "./host";

const repo = path.resolve(import.meta.dirname, "../../../..");
let browser = "";
try { browser = findSystemBrowser(); } catch { /* no browser is installed */ }

it.skipIf(!browser)("captures real animation, image and compressed glTF scenes from isolated portable resources", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-portable-capture-"));
  const assets = path.join(root, "runtime-assets"), harness = path.join(root, "direct-browser.js"), entry = path.join(root, "direct.mjs");
  await copyRuntimeDecoders(assets);
  await ensureDecoders(assets);
  await build({ entryPoints: [path.join(repo, "apps/studio/scripts/direct-browser/page.ts")], outfile: harness, bundle: true, platform: "browser", format: "iife", target: "es2020", minify: true });
  const shim = 'import {createRequire as __r} from "node:module"; import {fileURLToPath as __f} from "node:url"; const require=__r(import.meta.url); const __filename=__f(import.meta.url); const __dirname=__filename.slice(0,Math.max(__filename.lastIndexOf("/"),__filename.lastIndexOf("\\\\")));';
  await build({ entryPoints: [path.join(repo, "apps/studio/scripts/direct-browser/index.ts")], outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22", banner: { js: shim } });
  fs.cpSync(path.join(repo, "examples/local-media/assets"), path.join(root, "project/assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "project/assets/image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a1sAAAAASUVORK5CYII=", "base64"));
  const fixture = JSON.parse(fs.readFileSync(path.join(repo, "examples/local-media/readiness.scenescript.json"), "utf8"));
  fixture.scenes = fixture.scenes.filter((s: { id: string }) => ["lottie-motion", "gsap-motion", "three-code", "draco-gltf", "ktx2-gltf"].includes(s.id));
  fixture.scenes.push({ id: "image", kind: "image", src: "assets/image.png", narration: { text: "", durationMs: 1000 } });
  fs.writeFileSync(path.join(root, "project.json"), JSON.stringify(fixture));
  const code = `import fs from 'node:fs'; import {createDirectCapture} from ${JSON.stringify(pathToFileURL(entry).href)}; const p=JSON.parse(fs.readFileSync('project.json')); const c=await createDirectCapture(p,'project','public',320,180); try { for (const s of p.scenes) { await c.load(s); await c.screenshot(5,s.id+'.png'); console.log('captured '+s.id); } } finally { await c.close(); }`;
  const env = { ...process.env, TEMP: root, TMP: root, GLINT_CHROME_PATH: browser, GLINT_RUNTIME_ASSETS: assets, GLINT_DIRECT_BROWSER_HARNESS: harness };
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, env, encoding: "utf8", timeout: 120000 });
  expect(result.status, `${result.stdout}\n${result.stderr}\nfixture: ${root}`).toBe(0);
  for (const scene of fixture.scenes) {
    expect(result.stdout).toContain(`captured ${scene.id}`);
    const png = fs.readFileSync(path.join(root, `${scene.id}.png`));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(320);
    expect(png.length).toBeGreaterThan(300);
  }
  const hashes = fixture.scenes.map((scene: { id: string }) => createHash("sha256").update(fs.readFileSync(path.join(root, `${scene.id}.png`))).digest("hex"));
  expect(new Set(hashes).size).toBe(fixture.scenes.length);
  // Preserve the new isolated fixture as reproducible evidence.
}, 180000);
