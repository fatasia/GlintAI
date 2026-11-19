// MOTION-04: the animation:"three" sandbox path renders real WebGL through the
// same seek protocol as GSAP. Fixture: a self-contained factory scene (rotating
// cube, frame-pure seek) served with three.runtime.js inside the isolated
// wrapper. The wrapper relay only forwards glint:ready/seeked/seek-error, so
// in-sandbox probes cannot reach the page; every assertion therefore rides on
// decoded screenshots (region statistics) plus the iframe's sandbox attribute.
// Asserts in a real headless Chrome: the drawing buffer carries non-black
// content, the 2D overlay text band updates with t, repeat seeks stay
// pixel-stable while different times differ, and the boundary stays
// allow-scripts only.
//   tsx qa-three-scene-fixture.ts --out=evidence/MOTION-04/run-20261025b
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildHtmlSceneDocument, GLINT_SEEK_MESSAGE_TYPE } from "../../../packages/video/src/scenes/html-runtime";
import { isolatedHtmlFrame } from "../../../packages/video/src/scenes/html-policy";
import type { HtmlScene } from "@glintai/scenescript";
import { openCaptureBrowser, startAssetServer } from "./direct-browser/host";
import { copyRuntimeDecoders } from "./decoders";

const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const outDir = path.resolve(arg("out") ?? path.join("evidence", "MOTION-04", `run-${new Date().toISOString().slice(0, 10)}`));
const GENERATION = "motion04";
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "glint-motion04-"));

// Frame-pure factory: rotation/position are functions of t only. The overlay
// caption embeds t so the 2D/3D mixing is observable from screenshots alone.
const SCENE_HTML = `
<div id="glint-root" style="position:fixed;inset:0;background:#0b0d12"></div>
<div id="overlay" style="position:absolute;left:0;right:0;top:26px;text-align:center;color:#e4e4e7;font:600 22px sans-serif;pointer-events:none">三维混合叠加</div>
<script>
window.__glintThree = function (THREE, size) {
  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(40, size.width / size.height, 0.1, 100);
  camera.position.z = 6;
  var mesh = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.4, 2.4), new THREE.MeshNormalMaterial());
  scene.add(mesh);
  return { scene: scene, camera: camera, seek: function (t) {
    mesh.rotation.set(t * 1.4, t * 2.1, 0);
    mesh.position.x = Math.sin(t * Math.PI) * 1.4;
    var overlay = document.getElementById("overlay");
    if (overlay) overlay.textContent = "三维混合叠加 t=" + t.toFixed(2) + "s";
  } };
};
</script>`;
const scene: HtmlScene = { id: "three-fixture", kind: "html", html: SCENE_HTML, animation: "three", narration: { text: "三维混合" } };

const decodeGray = (file: string): { data: Buffer; width: number; height: number } => {
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { maxBuffer: 1 << 20 });
  const [width, height] = (probe.stdout.toString().trim().split(",") || ["0", "0"]).map(Number);
  const out = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { maxBuffer: 1 << 29 });
  if (out.status !== 0 || !out.stdout.length || !width || !height) throw new Error(`decode failed: ${file}`);
  return { data: out.stdout, width, height };
};
const region = (frame: { data: Buffer; width: number; height: number }, x: number, y: number, w: number, h: number) => {
  const values: number[] = [];
  for (let row = y; row < Math.min(y + h, frame.height); row++) {
    for (let col = x; col < Math.min(x + w, frame.width); col++) values.push(frame.data[row * frame.width + col]!);
  }
  return values;
};
const compare = (a: Buffer, b: Buffer) => {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!));
  return max;
};

const server = await startAssetServer(work);
await copyRuntimeDecoders(work); // stages three.runtime.js beside the host page
const runtimeSrc = `${server.url}/three.runtime.js`;
fs.writeFileSync(path.join(work, "host.html"), isolatedHtmlFrame(buildHtmlSceneDocument(scene, runtimeSrc, GENERATION), GENERATION, true, runtimeSrc));

const browser = await openCaptureBrowser(960, 540);
const page = browser.page;
let sandboxAttr = "", stableMax = -1, distinctMax = -1;
const stats: Record<string, { cubeMean: number; bandBright: number; bandDiffMax: number }> = {};
const failures: string[] = [];
try {
  await page.goto(server.url + "/host.html", { waitUntil: "load" });
  // Same string-form relay rationale as qa-gsap-seek-consistency: tsx/esbuild
  // keepNames injects a browser-undefined __name into serialized functions.
  await page.evaluate(`new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("glint:ready timed out")), 20000);
    window.addEventListener("message", function relay(event) {
      var data = event.data;
      if (!data || data.generation !== ${JSON.stringify(GENERATION)}) return;
      if (data.type === "glint:ready") { clearTimeout(timer); resolve(); return; }
    });
    window.__qaSeq = 0;
    window.__qaSeek = function (t) {
      return new Promise(function (resolve, reject) {
        var requestId = ++window.__qaSeq;
        var listener = function (event) {
          var data = event.data;
          if (!data || data.generation !== ${JSON.stringify(GENERATION)} || data.requestId !== requestId) return;
          window.removeEventListener("message", listener);
          if (data.type === "glint:seeked") resolve(); else reject(new Error(String(data.error)));
        };
        window.addEventListener("message", listener);
        window.frames[0].postMessage({ type: ${JSON.stringify(GLINT_SEEK_MESSAGE_TYPE)}, generation: ${JSON.stringify(GENERATION)}, requestId: requestId, t: t }, "*");
      });
    };
  })`) as Promise<void>;
  const seek = (t: number) => page.evaluate(`window.__qaSeek(${JSON.stringify(t)})`) as Promise<void>;

  await seek(0.8);
  await page.screenshot({ path: path.join(outDir, "seek-0.8s-a.png") });
  await seek(0.25);
  await page.screenshot({ path: path.join(outDir, "seek-0.25s.png") });
  await seek(0.8);
  await page.screenshot({ path: path.join(outDir, "seek-0.8s-c.png") });
  sandboxAttr = await page.evaluate(`document.getElementById("glint-document").getAttribute("sandbox")`) as string;

  const a = decodeGray(path.join(outDir, "seek-0.8s-a.png"));
  const b = decodeGray(path.join(outDir, "seek-0.25s.png"));
  const c = decodeGray(path.join(outDir, "seek-0.8s-c.png"));
  // Cube fills the middle of the frame; the overlay caption sits in the top band.
  const cube = (frame: { data: Buffer; width: number; height: number }) => region(frame, Math.floor(frame.width * 0.3), Math.floor(frame.height * 0.3), Math.floor(frame.width * 0.4), Math.floor(frame.height * 0.4));
  const band = (frame: { data: Buffer; width: number; height: number }) => region(frame, 0, 0, frame.width, Math.floor(frame.height * 0.18));
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  stats.a = { cubeMean: Math.round(mean(cube(a))), bandBright: band(a).filter(value => value > 200).length, bandDiffMax: compare(Buffer.from(band(a)), Buffer.from(band(b))) };
  stableMax = compare(a.data, c.data);
  distinctMax = compare(a.data, b.data);
  if (sandboxAttr !== "allow-scripts") failures.push(`sandbox=${sandboxAttr}`);
  if (stats.a.cubeMean < 20) failures.push(`centre pixels look empty: cubeMean=${stats.a.cubeMean}`);
  if (stats.a.bandBright < 30) failures.push(`overlay caption band has no bright text pixels: ${stats.a.bandBright}`);
  if (stats.a.bandDiffMax < 8) failures.push(`overlay caption did not change with t: bandDiffMax=${stats.a.bandDiffMax}`);
  if (stableMax > 2) failures.push(`repeat seek unstable: maxDiff=${stableMax}`);
  if (distinctMax < 20) failures.push(`different times render alike: maxDiff=${distinctMax}`);
} finally {
  await browser.browser.close().catch(() => {});
  await server.close().catch(() => {});
  fs.rmSync(work, { recursive: true, force: true });
}
const summary = {
  ranAt: new Date().toISOString(), generation: GENERATION, sandboxAttr,
  probeAtT08: stats.a ?? null,
  repeatSeekMaxDiff: stableMax, distinctSeekMaxDiff: distinctMax,
  thresholds: { cubeMeanMin: 20, bandBrightMin: 30, bandDiffMaxMin: 8, stableMax: 2, distinctMin: 20 },
  failures,
  verdict: failures.length === 0
    ? "PASS: WebGL canvas renders through the sandbox seek protocol, stays pixel-stable on repeat seeks, differs across times, and the 2D overlay caption updates with t (observed via decoded screenshots; the wrapper relay forwards only protocol messages)"
    : `FAIL: ${failures.join("; ")}`,
  instrument: "real three.runtime.js + MeshNormalMaterial cube; region statistics from decoded screenshots (cube mean gray, overlay bright-pixel count, caption band diff); pairwise decoded-gray comparison",
};
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`[motion04] ${summary.verdict}; summary → ${path.join(outDir, "summary.json")}`);
if (failures.length > 0) process.exitCode = 1;
