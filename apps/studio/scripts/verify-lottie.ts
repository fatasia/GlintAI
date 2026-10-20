import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import {
  openBrowser,
  renderFrames,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
import { copyRuntimeDecoders } from "./decoders";
const studio = fileURLToPath(new URL("../", import.meta.url)),
  repo = path.resolve(studio, "../.."),
  p = JSON.parse(
    fs.readFileSync(
      path.join(repo, "examples/local-media/readiness.scenescript.json"),
      "utf8",
    ),
  );
p.scenes = p.scenes.filter((s: any) => s.animation === "lottie");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "glint-lottie-check-"));
await copyRuntimeDecoders(path.join(studio, "public"));
const serveUrl = await bundle({
  entryPoint: path.join(studio, "src/index.ts"),
});
const browser = await openBrowser("chrome");
try {
  const inputProps = { project: p },
    composition = await selectComposition({
      serveUrl,
      id: "Glint",
      inputProps,
      puppeteerInstance: browser,
    });
  const pngs = new Map<number, Buffer>();
  await renderFrames({
    serveUrl,
    composition,
    inputProps,
    puppeteerInstance: browser,
    concurrency: 1,
    outputDir: null,
    imageFormat: "png",
    onStart: () => {},
    onFrameUpdate: () => {},
    onFrameBuffer: (b, f) => {
      pngs.set(f, b);
      fs.writeFileSync(path.join(out, `${f}.png`), b);
    },
  });
  const { buffer } = await renderStill({
    serveUrl,
    composition,
    inputProps,
    puppeteerInstance: browser,
    frame: 5,
    imageFormat: "png",
  });
  assert(buffer);
  fs.writeFileSync(path.join(out, "cold5.png"), buffer);
  assert.deepEqual(buffer, pngs.get(5));
  console.log(`Lottie canvas cold/sequential PNG exact: ${out}`);
} finally {
  await browser.close({ silent: true });
}
