// MOTION-03: GSAP scenes must show the same pixels for a seeked frame no matter
// which order frames were visited in. Instrument: one deterministic GSAP
// timeline (stagger with overshoot ease, colour tween, yoyo repeat, transform
// chain) inside the real sandbox protocol (isolatedHtmlFrame wrapper + glue
// snippet + gsap.min.js served from the workspace). A linear sweep captures
// every sample in order; a second fresh document revisits the same timestamps
// in a seeded random order with out-of-order revisits; every pair is compared
// pixel-wise from decoded PNGs.
//   tsx qa-gsap-seek-consistency.ts --out=evidence/MOTION-03/run-20261025b [--samples=36]
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
const outDir = path.resolve(arg("out") ?? path.join("evidence", "MOTION-03", `run-${new Date().toISOString().slice(0, 10)}`));
const SAMPLES = Number(arg("samples") ?? 36);
const GENERATION = "motion03";
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "glint-motion03-"));

// Adversarial-but-declarative timeline: no wall clock, no random, no callbacks —
// exactly the shape the runtime contract demands, with the constructs most
// likely to break naive seeking (immediateRender fromTo, yoyo repeat, stagger).
const SCENE_HTML = `
<div id="stage" style="position:fixed;inset:0;background:#101014;overflow:hidden;font-family:sans-serif">
  <div id="dot" style="position:absolute;left:20px;top:110px;width:44px;height:44px;border-radius:50%;background:#f65c35"></div>
  <div id="ring" style="position:absolute;left:760px;top:40px;width:70px;height:70px;border:6px solid #38bdf8;border-radius:50%"></div>
  <div id="bars" style="position:absolute;left:40px;right:40px;top:230px;display:flex;gap:12px;align-items:flex-end;height:200px">
    ${Array.from({ length: 6 }, () => `<i style="flex:1;height:200px;background:#38bdf8;display:block;transform:scaleY(0);transform-origin:bottom"></i>`).join("")}
  </div>
  <div id="foot" style="position:absolute;left:40px;bottom:30px;width:220px;height:14px;background:#a78bfa"></div>
</div>
<script>
window.__glintTimeline = function (gsap) {
  var tl = gsap.timeline({ paused: true });
  tl.fromTo("#dot", { x: 0 }, { x: 800, duration: 2.6, ease: "power1.inOut" }, 0)
    .fromTo("#bars i", { scaleY: 0 }, { scaleY: 1, duration: 0.8, stagger: 0.15, ease: "back.out(2.4)" }, 0.2)
    .fromTo("#stage", { backgroundColor: "#101014" }, { backgroundColor: "#2b1055", duration: 2.2, ease: "none" }, 0.4)
    .fromTo("#ring", { rotation: 0 }, { rotation: 260, duration: 1.1, repeat: 1, yoyo: true, ease: "sine.inOut" }, 0.5)
    .to("#dot", { scale: 1.6, backgroundColor: "#fbbf24", duration: 0.7, ease: "power2.out" }, 1.3)
    .fromTo("#foot", { x: -220 }, { x: 0, duration: 0.9, ease: "expo.out" }, 1.8);
  return tl;
};
</script>`;
const scene: HtmlScene = { id: "gsap-parity", kind: "html", html: SCENE_HTML, animation: "gsap", narration: { text: "GSAP seek 一致性" } };

const decodeGray = (file: string): Buffer => {
  const out = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { maxBuffer: 1 << 29 });
  if (out.status !== 0 || !out.stdout.length) throw new Error(`decode failed: ${file}: ${out.stderr?.toString().slice(0, 200)}`);
  return out.stdout;
};
const compare = (a: Buffer, b: Buffer) => {
  let max = 0, sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = Math.abs(a[i]! - b[i]!);
    max = Math.max(max, diff); sum += diff;
  }
  return { max, mean: sum / a.length };
};

// Linear sweep captures 0..2.9166s at 12fps; the random pass revisits the same
// list shuffled (xorshift seed) plus explicit out-of-order revisits.
const times: number[] = [];
for (let i = 0; i < SAMPLES; i++) times.push(Number((i / 12).toFixed(4)));
let seed = 20261025;
const random = () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const order = times.map((_, index) => index);
for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
const revisit = [order[4]!, order[9]!, order[17]!, order[2]!];
const randomOrder = [...order, ...revisit];

const server = await startAssetServer(work);
await copyRuntimeDecoders(work); // stages gsap.min.js into the served workspace
const gsapSrc = `${server.url}/gsap.min.js`;
fs.writeFileSync(path.join(work, "host.html"), isolatedHtmlFrame(buildHtmlSceneDocument(scene, gsapSrc, GENERATION), GENERATION, true, gsapSrc));

const browser = await openCaptureBrowser(960, 540);
const page = browser.page;
let mismatches = 0, worstMax = -1, worstAt = 0;
const results: Array<{ index: number; time: number; maxDiff: number; meanDiff: number }> = [];
try {
  // The sandboxed child is opaque-origin: readiness is only observable through
  // the relayed glint:ready message; seeks posted before it are dropped.
  // String-form evaluate: tsx/esbuild keepNames rewrites function bodies with a
  // __name helper that does not exist in the browser, so the relay must ship as
  // raw source, never as a serialized function.
  const relaySource = `new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("glint:ready timed out")), 15000);
    window.addEventListener("message", function relay(event) {
      var data = event.data;
      if (!data || data.generation !== ${JSON.stringify(GENERATION)}) return;
      if (data.type === "glint:ready") { clearTimeout(timer); resolve(); return; }
      if (data.type !== "glint:seeked" && data.type !== "glint:seek-error") return;
      var pending = window.__qa && window.__qa.pending.get(data.requestId);
      if (!pending) return;
      window.__qa.pending.delete(data.requestId);
      if (data.type === "glint:seeked") pending.resolve(); else pending.reject(new Error(String(data.error)));
    });
    window.__qa = {
      seq: 0, pending: new Map(),
      seek: function (t) {
        return new Promise(function (resolve, reject) {
          var requestId = ++window.__qa.seq;
          window.__qa.pending.set(requestId, { resolve: resolve, reject: reject });
          window.frames[0].postMessage({ type: ${JSON.stringify(GLINT_SEEK_MESSAGE_TYPE)}, generation: ${JSON.stringify(GENERATION)}, requestId: requestId, t: t }, "*");
        });
      },
    };
  })`;
  const installRelay = () => page.evaluate(relaySource) as Promise<void>;
  const seek = (t: number) => page.evaluate(`window.__qa.seek(${JSON.stringify(t)})`) as Promise<void>;

  await page.goto(server.url + "/host.html", { waitUntil: "load" });
  await installRelay();
  for (const [index, time] of times.entries()) {
    await seek(time);
    await page.screenshot({ path: path.join(work, `lin-${index}.png`) });
  }
  await page.goto("about:blank");
  await page.goto(server.url + "/host.html", { waitUntil: "load" });
  await installRelay();
  for (const index of randomOrder) {
    await seek(times[index]!);
    await page.screenshot({ path: path.join(work, `rnd-${index}.png`) });
  }
  for (const [index, time] of times.entries()) {
    const { max, mean } = compare(decodeGray(path.join(work, `lin-${index}.png`)), decodeGray(path.join(work, `rnd-${index}.png`)));
    results.push({ index, time, maxDiff: max, meanDiff: Number(mean.toFixed(4)) });
    if (max > worstMax) { worstMax = max; worstAt = index; }
    if (max > 2) {
      mismatches++;
      fs.copyFileSync(path.join(work, `lin-${index}.png`), path.join(outDir, `mismatch-lin-${index}.png`));
      fs.copyFileSync(path.join(work, `rnd-${index}.png`), path.join(outDir, `mismatch-rnd-${index}.png`));
    }
  }
  for (const index of [0, Math.floor(times.length / 2), times.length - 1]) {
    fs.copyFileSync(path.join(work, `lin-${index}.png`), path.join(outDir, `pair-lin-${times[index]}s.png`));
    fs.copyFileSync(path.join(work, `rnd-${index}.png`), path.join(outDir, `pair-rnd-${times[index]}s.png`));
  }
} finally {
  await browser.browser.close().catch(() => {});
  await server.close().catch(() => {});
  fs.rmSync(work, { recursive: true, force: true });
}
const summary = {
  ranAt: new Date().toISOString(), samples: times.length, randomVisits: randomOrder.length,
  toleranceMaxGray: 2, worst: { index: worstAt, time: times[worstAt]!, maxDiff: worstMax },
  mismatches,
  verdict: mismatches === 0
    ? `PASS: ${times.length} seeked frames revisited out of order (${randomOrder.length} visits) all match their linear-pass pixels`
    : `FAIL: ${mismatches}/${times.length} frames diverge between random seek and linear sweep`,
  instrument: "deterministic GSAP timeline (stagger back.out, yoyo repeat, colour tween) through the sandbox seek protocol; pairwise decoded-gray comparison",
};
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`[motion03] ${summary.verdict}; worst maxDiff=${worstMax} at t=${times[worstAt]}s; summary → ${path.join(outDir, "summary.json")}`);
if (mismatches > 0) process.exitCode = 1;
