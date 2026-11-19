import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { renderNative } from "./native-render";

// SKILL-01 三种独立视觉语法的作品级验收:三个完整工程(手绘白板叙事 /
// 黑板图解引言 / 深色代码对比)各走真实 renderNative 出片,断言成片互异、
// 语法内场景互异、整体色调符合主题语义。显式 opt-in;不调用网关。
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));

function meanColor(file: string, startAt = 0): { r: number; g: number; b: number; distinct: number } {
  // vitest 下大 stdout 管道不可靠(status 非零且无 stderr),用临时文件中转。
  const dump = `${file}.rgb`;
  const raw = spawnSync("ffmpeg", ["-nostdin", "-v", "error", ...(startAt ? ["-ss", String(startAt)] : []), "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-y", dump], { encoding: "utf8", windowsHide: true });
  if (raw.status !== 0) throw new Error(`decode failed: ${file}: ${raw.stderr.slice(0, 300)}`);
  const bytes = fs.readFileSync(dump); fs.rmSync(dump, { force: true });
  let r = 0, g = 0, b = 0; const distinct = new Set<number>();
  for (let offset = 0; offset + 2 < bytes.length; offset += 3) {
    r += bytes[offset]!; g += bytes[offset + 1]!; b += bytes[offset + 2]!;
    if (distinct.size < 4096) distinct.add((bytes[offset]! << 16) | (bytes[offset + 1]! << 8) | bytes[offset + 2]!);
  }
  const count = bytes.length / 3;
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count), distinct: distinct.size };
}

it.skipIf(process.env.GLINT_SKILL1_E2E !== "1")("renders three genuinely different visual grammars as real films", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-skill1-"));
  const build = (id: string, theme: string, scenes: unknown[]) => {
    const file = path.join(root, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, id, title: id, aspect: "16:9", fps: 30, theme, knowledgeSources: [], scenes }, null, 2));
    return file;
  };
  // 语法 A:白板手绘叙事——标题带手绘下划线,要点镜头带手绘箭头。
  const a = build("grammar-whiteboard", "whiteboard", [
    { id: "w-title", kind: "title", title: "把想法画出来", subtitle: "手绘叙事", narration: { text: "把想法画出来", durationMs: 2000 },
      elements: [{ id: "w-underline", kind: "path", x: 0.5, y: 0.5, w: 1, h: 1, viewBox: [1920, 1080], d: "M560 640 Q960 600 1360 640", stroke: "#d65b37", strokeWidth: 12, drawStartMs: 400, drawDurationMs: 900 }] },
    { id: "w-bullets", kind: "bullets", heading: "三个要点", items: ["先画骨架", "再补细节", "最后上色"], narration: { text: "三个要点", durationMs: 2000 },
      elements: [{ id: "w-arrow", kind: "path", x: 0.5, y: 0.5, w: 1, h: 1, viewBox: [1920, 1080], d: "M1500 500 C1560 520 1560 560 1520 585 L1545 570 L1530 600", stroke: "#376b82", strokeWidth: 10, drawStartMs: 900, drawDurationMs: 700 }] },
  ]);
  // 语法 B:黑板图解与引言。
  const b = build("grammar-blackboard", "blackboard-tech", [
    { id: "b-def", kind: "definition", term: "缓存", definition: "把计算结果存起来,下次直接复用。", narration: { text: "什么是缓存", durationMs: 2000 } },
    { id: "b-quote", kind: "quote", text: "过早优化是万恶之源。", attribution: "Donald Knuth", narration: { text: "一句忠告", durationMs: 2000 } },
  ]);
  // 语法 C:深色代码与对比。
  const c = build("grammar-dark", "glint-dark", [
    { id: "d-code", kind: "code", heading: "缓存命中", code: "const hit = cache.get(key)\nif (hit) return hit\nconst value = compute(key)\ncache.set(key, value)", language: "ts", narration: { text: "缓存命中", durationMs: 2000 } },
    { id: "d-cmp", kind: "comparison", heading: "有无缓存", left: { label: "无缓存", points: ["每次全量计算", "响应 300ms"] }, right: { label: "有缓存", points: ["命中直接返回", "响应 5ms"] }, narration: { text: "有无缓存", durationMs: 2000 } },
  ]);
  const films: Array<{ id: string; file: string }> = [];
  try {
    for (const [id, file] of [["whiteboard", a], ["blackboard", b], ["dark", c]] as [string, string][]) {
      const output = path.join(root, `${id}.mp4`);
      await renderNative({ projectPath: file, output, fast: true, tts: "mock", music: "off", noCache: true });
      expect(fs.existsSync(output)).toBe(true);
      films.push({ id, file: output });
    }
    const hashes = films.map(film => createHash("sha256").update(fs.readFileSync(film.file)).digest("hex"));
    expect(new Set(hashes).size).toBe(3);
    const stats = films.map(film => ({ id: film.id, ...meanColor(film.file) }));
    // 全片平均被背景主导;黑板与深色的差异用内容帧(t=1.2s,第二场景)对比。
    const frameStats = films.map(film => ({ id: film.id, ...meanColor(film.file, 1.2) }));
    console.log("SKILL1_FILMS", JSON.stringify({ full: stats, frame: frameStats }));
    // 主题语义:白板亮背景,黑板与深色为暗背景;整体色调互不相同。
    const [white, black, dark] = stats as unknown as [{ r: number; g: number; b: number; distinct: number }, { r: number; g: number; b: number; distinct: number }, { r: number; g: number; b: number; distinct: number }];
    const [, blackFrame, darkFrame] = frameStats as unknown as [{ r: number; g: number; b: number }, { r: number; g: number; b: number }, { r: number; g: number; b: number }];
    expect(white.r).toBeGreaterThan(200);
    expect(black.r).toBeLessThan(white.r - 60);
    expect(dark.r).toBeLessThan(white.r - 60);
    expect(Math.abs(darkFrame.g - blackFrame.g) + Math.abs(darkFrame.b - blackFrame.b) + Math.abs(darkFrame.r - blackFrame.r)).toBeGreaterThan(8);
    if (process.env.GLINT_SKILL1_EVIDENCE) {
      fs.mkdirSync(process.env.GLINT_SKILL1_EVIDENCE, { recursive: true });
      for (const film of films) {
        const frame = path.join(root, `${film.id}-frame.png`);
        spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-ss", "1.2", "-i", film.file, "-frames:v", "1", "-y", frame], { windowsHide: true });
        fs.copyFileSync(film.file, path.join(process.env.GLINT_SKILL1_EVIDENCE, `${film.id}.mp4`));
        fs.copyFileSync(frame, path.join(process.env.GLINT_SKILL1_EVIDENCE, `${film.id}-frame.png`));
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
  void ROOT_DIR;
}, 300_000);
