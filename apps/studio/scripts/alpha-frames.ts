import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { parseProject, buildTimeline, timelineToFrames, frameRateOf } from "@glintai/scenescript";
import { resolveTheme } from "@glintai/design-tokens";
import { createTextOutliner } from "./native-svg/outline";
import { renderSceneSvg, supportsNativeScene } from "./native-svg";

/** Separate, bounded SVG-only PNG sequence; never reuses opaque MP4 caches. */
export async function exportAlphaFrames(options: { projectPath: string; outDir: string; width?: number; height?: number; signal?: AbortSignal }) {
  const project = parseProject(JSON.parse(fs.readFileSync(path.resolve(options.projectPath), "utf8")));
  const issues = project.scenes.flatMap(scene => [
    ...(!supportsNativeScene(scene) ? [`${scene.id}: ${scene.kind} 场景不支持透明 PNG`] : []),
    ...(scene.transition?.overlapMs ? [`${scene.id}: 不支持交叠转场`] : []),
    ...(scene.effects?.length ? [`${scene.id}: 不支持场景滤镜`] : []),
  ]);
  if (issues.length) throw new Error(`透明输出预检失败：${issues.join("；")}`);
  const width = options.width ?? (project.aspect === "9:16" ? 540 : 960), height = options.height ?? (project.aspect === "9:16" ? 960 : project.aspect === "1:1" ? 960 : 540);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 16 || height < 16 || width > 1920 || height > 1920 || width * height > 921600) throw new Error("尺寸必须为至少 16 像素、每边不超过 1920 且总计不超过 921600 像素的整数。");
  const [aspectWidth, aspectHeight] = project.aspect.split(":").map(Number);
  if (width * aspectHeight! !== height * aspectWidth!) throw new Error("输出尺寸必须与工程画幅一致。");
  const fps = project.fps ?? 30, { entries, durationInFrames } = timelineToFrames(buildTimeline(project), fps);
  if (!entries.length || durationInFrames < 1 || durationInFrames > 300) throw new Error("透明序列限 1–300 帧。");
  const out = path.resolve(options.outDir);
  if (fs.existsSync(out)) throw new Error("输出目录已存在，不会覆盖。");
  options.signal?.throwIfAborted();
  fs.mkdirSync(out); let completed = false;
  try {
    const fontFiles = process.platform === "win32" ? ["msyh.ttc", "msyhbd.ttc", "simkai.ttf", "consola.ttf"].map(name => path.join(process.env.WINDIR ?? "C:/Windows", "Fonts", name)).filter(file => fs.existsSync(file)) : [];
    const outline = createTextOutliner({ loadSystemFonts: fontFiles.length === 0, fontFiles, defaultFontFamily: "Microsoft YaHei" }, width, height, resolveTheme(project.theme).fonts.body);
    let totalBytes = 0, sceneIndex = 0;
    for (let frame = 0; frame < durationInFrames; frame++) {
      options.signal?.throwIfAborted();
      while (sceneIndex + 1 < entries.length && entries[sceneIndex + 1]!.from <= frame) sceneIndex++;
      const entry = entries[sceneIndex]!, previous = sceneIndex > 0 ? entries[sceneIndex - 1]!.scene : undefined;
      const svg = renderSceneSvg(project, entry.scene, frame - entry.from, { width, height, previousScene: previous, transparentBackground: true });
      const png = new Resvg(outline(svg), { font: { loadSystemFonts: false } }).render().asPng();
      totalBytes += png.length;
      if (totalBytes > 256 * 1024 * 1024) throw new Error("透明序列超过 256 MiB 上限。");
      fs.writeFileSync(path.join(out, `${String(frame).padStart(6, "0")}.png`), png, { flag: "wx" });
      if (frame % 30 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    const manifest = { projectId: project.id, width, height, fps: frameRateOf(fps).text, frames: durationInFrames, bytes: totalBytes, alpha: true, audio: false, scope: "svg-scenes-only" };
    fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
    completed = true;
    return { out, ...manifest };
  } finally { if (!completed) fs.rmSync(out, { recursive: true, force: true }); }
}
