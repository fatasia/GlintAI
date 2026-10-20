import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderFrames, renderStill, selectComposition } from "@remotion/renderer";
import { buildTimeline, parseProject, timelineToFrames } from "@glintai/scenescript";
import { copyProjectAssets } from "./assets";
import { copyRuntimeDecoders, ensureDecoders } from "./decoders";

const studio = fileURLToPath(new URL("../", import.meta.url));
const repo = path.resolve(studio, "../..");
const args = process.argv.slice(2);
assert(args.every((arg) => /^--(?:out|scale)=/.test(arg)), "Only --out= and --scale= are supported");
const outArg = args.find((arg) => arg.startsWith("--out="))?.slice(6);
const scale = Number(args.find((arg) => arg.startsWith("--scale="))?.slice(8) ?? "0.5");
assert(scale === 0.5 || scale === 1, "scale must be 0.5 or 1");
const parent = outArg ? path.resolve(process.env.INIT_CWD || process.cwd(), outArg) : os.tmpdir();
const relative = path.relative(repo, parent);
assert(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "Verification output must be outside the repository");
fs.mkdirSync(parent, { recursive: true });
const out = fs.mkdtempSync(path.join(parent, "glint-render-check-"));
const report: Record<string, unknown> = { status: "running", scale, node: process.version, output: out };
const started = performance.now();
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function pixels(png: Buffer, width: number, height: number) {
  const decoded = spawnSync("ffmpeg", ["-v", "error", "-f", "image2pipe", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], {
    input: png, shell: false, timeout: 30_000, maxBuffer: width * height * 4 + 1024 * 1024,
  });
  if (decoded.error) throw decoded.error;
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  const rgba = decoded.stdout;
  assert.equal(rgba.length, width * height * 4, "Unexpected decoded dimensions");
  // Exclude subtitles, progress bar and branding. This probes actual scene content.
  const rows: Buffer[] = [];
  let bright = 0;
  for (let y = Math.floor(height * .25); y < Math.floor(height * .55); y++) {
    const row = rgba.subarray((y * width + Math.floor(width * .3)) * 4, (y * width + Math.floor(width * .7)) * 4);
    rows.push(row);
    for (let x = 0; x < row.length; x += 4) if (row[x]! + row[x + 1]! + row[x + 2]! > 350) bright++;
  }
  return { rgbaHash: hash(rgba), sceneHash: hash(Buffer.concat(rows)), brightPixels: bright };
}

async function main() {
  const fixture = path.join(repo, "examples/local-media/readiness.scenescript.json");
  const raw = parseProject(JSON.parse(fs.readFileSync(fixture, "utf8")));
  const publicDir = path.join(studio, "public");
  const project = await copyProjectAssets(path.dirname(fixture), publicDir, raw);
  await Promise.all([copyRuntimeDecoders(publicDir), ensureDecoders(publicDir)]);
  const serveUrl = await bundle({ entryPoint: path.join(studio, "src/index.ts"), publicDir });
  const browser = await openBrowser("chrome");
  try {
    const inputProps = { project };
    const composition = await selectComposition({ serveUrl, id: "Glint", inputProps, puppeteerInstance: browser });
    const width = composition.width * scale, height = composition.height * scale;
    const frames = Array.from({ length: composition.durationInFrames }, (_, frame) => frame);
    report.width = width; report.height = height; report.framesPerPass = frames.length;
    const baseline = new Map<number, ReturnType<typeof pixels>>();
    report.frameHashes = {};
    for (const pass of ["first", "repeat"]) {
      const dir = path.join(out, pass); fs.mkdirSync(dir);
      const seen = new Set<number>();
      await renderFrames({ serveUrl, composition, inputProps, puppeteerInstance: browser, scale,
        concurrency: 1, imageFormat: "png", outputDir: null, muted: true,
        onStart: () => {}, onFrameUpdate: () => {},
        onFrameBuffer: (png, frame) => {
          const value = pixels(png, width, height);
          fs.writeFileSync(path.join(dir, `${frame}.png`), png);
          if (pass === "first") {
            baseline.set(frame, value);
            (report.frameHashes as Record<string, unknown>)[frame] = value;
          }
          else assert.equal(value.rgbaHash, baseline.get(frame)?.rgbaHash, `RGBA mismatch in repeat frame ${frame}`);
          seen.add(frame);
        },
      });
      assert.equal(seen.size, frames.length, `${pass} did not capture every frame`);
      console.log(`[verify] ${pass}: ${seen.size} frames`);
    }
    const { entries } = timelineToFrames(buildTimeline(project), composition.fps);
    for (const entry of entries) {
      const early = baseline.get(entry.from + 2)!;
      const late = baseline.get(entry.from + entry.duration - 1)!;
      assert(late.brightPixels > width * height * .002, `${entry.scene.id}: scene content is blank`);
      assert.notEqual(early.sceneHash, late.sceneHash, `${entry.scene.id}: scene content is not changing`);
    }
    // renderFrames sorts its frames option. Cold renderStill requests below are
    // deliberately shuffled instead; they do not claim same-page random seeks.
    const order = entries.flatMap((entry) => [entry.from, entry.from + 5, entry.from + entry.duration - 1]);
    let seed = 20261020;
    for (let i = order.length - 1; i > 0; i--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const j = seed % (i + 1); [order[i], order[j]] = [order[j]!, order[i]!];
    }
    order.push(order[0]!);
    const coldDir = path.join(out, "cold"); fs.mkdirSync(coldDir);
    report.coldSeekOrder = order;
    for (const frame of order) {
      const { buffer } = await renderStill({ serveUrl, composition, inputProps, puppeteerInstance: browser, frame, scale, imageFormat: "png" });
      assert(buffer);
      fs.writeFileSync(path.join(coldDir, `${frame}.png`), buffer);
      const value = pixels(buffer, width, height);
      assert.equal(value.rgbaHash, baseline.get(frame)?.rgbaHash, `RGBA mismatch in cold seek ${frame}`);
    }
    report.coldSeekOrder = order;
    console.log(`[verify] cold shuffled seeks: ${order.join(", ")}`);

    const frameMap = [...frames];
    for (let i=frameMap.length-1;i>0;i--) { seed=(Math.imul(seed,1664525)+1013904223)>>>0; const j=seed%(i+1); [frameMap[i],frameMap[j]]=[frameMap[j]!,frameMap[i]!]; }
    frameMap.push(frameMap[0]!, frameMap.at(-1)!);
    const seekProps={project,frameMap};
    const seekComposition=await selectComposition({serveUrl,id:"GlintSeekVerification",inputProps:seekProps,puppeteerInstance:browser});
    const documentIds=new Set<string>();
    const seekDir=path.join(out,"same-document");fs.mkdirSync(seekDir);
    let captured=0;
    await renderFrames({serveUrl,composition:seekComposition,inputProps:seekProps,puppeteerInstance:browser,scale,concurrency:1,imageFormat:"png",outputDir:null,muted:true,
      onStart:()=>{},onFrameUpdate:()=>{},
      onBrowserLog:log=>{const match=/\[glint-seek-document\] ([\d.]+)/.exec(log.text);if(match)documentIds.add(match[1]!);},
      onFrameBuffer:(png,frame)=>{const target=frameMap[frame]!;assert.equal(pixels(png,width,height).rgbaHash,baseline.get(target)?.rgbaHash,`RGBA mismatch in same-document seek ${frame} -> ${target}`);fs.writeFileSync(path.join(seekDir,`${frame}-${target}.png`),png);captured++;},
    });
    assert.equal(captured,frameMap.length);assert.equal(documentIds.size,1,"Random-seek frames must share exactly one browser document");
    report.sameDocument={frameMap,captured,documentCount:documentIds.size,method:"Freeze frame context with one renderFrames page, concurrency=1"};
    console.log(`[verify] same-document shuffled/repeated seeks: ${captured}`);

    // Compare an animated frame against an otherwise identical frozen timeline:
    // changing subtitles/entrance fades alone cannot satisfy this check.
    const frozen = structuredClone(project);
    const animated = frozen.scenes.at(-1)!;
    assert(animated.kind === "html");
    animated.html = animated.html.replace(/<script>[\s\S]*?<\/script>/, '<script>window.__glintTimeline = (gsap) => gsap.timeline({paused:true});</script>');
    const finalFrame = frames.at(-1)!;
    const frozenComposition = await selectComposition({ serveUrl, id: "Glint", inputProps: { project: frozen }, puppeteerInstance: browser });
    const still = await renderStill({ serveUrl, composition: frozenComposition, inputProps: { project: frozen }, puppeteerInstance: browser, frame: finalFrame, scale, imageFormat: "png" });
    assert(still.buffer);
    assert.notEqual(pixels(still.buffer, width, height).sceneHash, baseline.get(finalFrame)?.sceneHash, "GSAP motion did not affect scene pixels");
    const failures = [
      { name: "missing-factory", html: "<div>No factory</div>", error: /Missing window.__glintTimeline/ },
      { name: "throwing-seek", html: '<script>window.__glintTimeline = () => ({pause(){return this},seek(){throw new Error("broken-seek")}});</script>', error: /broken-seek/ },
      { name: "broken-image", html: '<img src="/missing-render-test-image.png"><script>window.__glintTimeline = (gsap) => gsap.timeline({paused:true});</script>', error: /HTML image failed to load|source image cannot be decoded/ },
      { name: "broken-font", html: '<style>@font-face{font-family:Broken;src:url("/missing-render-test-font.woff2")}body{font-family:Broken}</style>字体失败<script>window.__glintTimeline = (gsap) => gsap.timeline({paused:true});</script>', error: /HTML font failed to load/ },
    ];
    for (const fixture of failures) {
      const invalid = parseProject({ ...project, scenes: [{ id: fixture.name, kind: "html", animation: "gsap", html: fixture.html, narration: { text: "失败反例", durationMs: 500 } }] });
      const invalidComposition = await selectComposition({ serveUrl, id: "Glint", inputProps: { project: invalid }, puppeteerInstance: browser });
      await assert.rejects(renderStill({ serveUrl, composition: invalidComposition, inputProps: { project: invalid }, puppeteerInstance: browser, scale, frame: 0 }), fixture.error);
      console.log(`[verify] rejected: ${fixture.name}`);
    }
    report.rejectedFixtures = failures.map((fixture) => fixture.name);
    let requests=0,violations=0;
    const audit=http.createServer((_req,res)=>{requests++;res.end("unexpected network request");});
    await new Promise<void>(resolve=>audit.listen(0,"127.0.0.1",resolve));
    const target=`http://127.0.0.1:${(audit.address() as {port:number}).port}`;
    try {
      const html=`<div id="probe" style="color:white;font:40px sans-serif">资源隔离检查</div><img src="${target}/image" onerror="this.remove()"><iframe src="${target}/frame"></iframe><style>body{background-image:url('${target}/style')}</style><form action="${target}/form" method="post"></form><script src="${target}/script"></script><script>
        let denied=false;try{parent.document.body.setAttribute('data-unsafe','yes')}catch{denied=true}
        try{fetch('${target}/fetch').catch(()=>{})}catch{}
        try{navigator.sendBeacon('${target}/beacon','test')}catch{}
        try{let x=new XMLHttpRequest();x.open('GET','${target}/xhr');x.send()}catch{}
        try{new Worker('${target}/worker')}catch{}
        try{document.querySelector('form').submit()}catch{}
        window.__glintTimeline=(gsap)=>{if(!denied)throw new Error('Parent DOM accessible');return gsap.timeline({paused:true})};
      </script>`;
      const secure=parseProject({...project,scenes:[{id:"security-probe",kind:"html",animation:"gsap",html,narration:{text:"隔离检查",durationMs:500}}]});
      const props={project:secure},comp=await selectComposition({serveUrl,id:"Glint",inputProps:props,puppeteerInstance:browser});
      await renderStill({serveUrl,composition:comp,inputProps:props,puppeteerInstance:browser,frame:5,scale,onBrowserLog:log=>{if(/Content Security Policy|sandboxed/.test(log.text))violations++;}});
      const navigation=parseProject({...secure,scenes:[{...secure.scenes[0],html:`<script>location.href='${target}/navigate';window.__glintTimeline=(gsap)=>gsap.timeline({paused:true});</script>`}]});
      const navProps={project:navigation},navComp=await selectComposition({serveUrl,id:"Glint",inputProps:navProps,puppeteerInstance:browser});
      await assert.rejects(renderStill({serveUrl,composition:navComp,inputProps:navProps,puppeteerInstance:browser,frame:5,scale}),/timed out|readiness|seek/i);
      assert.equal(requests,0,"Sandbox probes must not reach the network target");assert(violations>=5,"Browser must report enforcing resource restrictions");
      report.htmlIsolation={networkRequests:requests,enforcedViolations:violations,parentDomAccess:"denied",scope:"fetch/XHR/beacon/image/script/CSS/frame/worker/form/self-navigation probes; not a general hostile-code audit"};
    }finally{audit.closeAllConnections();await new Promise<void>(resolve=>audit.close(()=>resolve()));}
    report.frameHashes = Object.fromEntries(baseline);
    report.status = "passed";
  } finally { await browser.close({ silent: true }); }
}
main().catch((error: unknown) => {
  report.status = "failed"; report.error = error instanceof Error ? error.message : String(error);
  console.error(`[verify] failed: ${report.error}`); process.exitCode = 1;
}).finally(() => {
  report.durationSeconds = (performance.now() - started) / 1000;
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(`[verify] ${report.status}: ${out}`);
});
