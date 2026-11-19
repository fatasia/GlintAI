import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseProject, sceneDurationMs, type HtmlScene } from "@glintai/scenescript";
import { readArg } from "./glint-runtime";

type Lottie = Record<string, unknown> & { fr: number; ip: number; op: number; w: number; h: number; layers: unknown[] };
type Settings = { version: 1; sourceFr: number; speed: number; scale: number; opacity: number };
const maxBytes = 256 * 1024;
const maxTextBytes = 4096;
const markerPattern = /^<!--glint-lottie:([^>]{1,1000})-->/;
const prefix = '<div id="glint-root" style="position:absolute;inset:0;width:100%;height:100%;';

/** Restrictive import contract, not a complete Lottie validator. */
export function validateLottie(input: unknown): asserts input is Lottie {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Lottie JSON 必须是对象。");
  const value = input as Lottie;
  if (![value.fr, value.ip, value.op, value.w, value.h].every(Number.isFinite) || value.fr <= 0 || value.fr > 240 || value.op <= value.ip || value.op - value.ip < 1 || value.w <= 0 || value.h <= 0 || value.w > 4096 || value.h > 4096 || (value.op - value.ip) / value.fr > 600) throw new Error("Lottie 尺寸、帧率或时长超出范围。");
  if (!Array.isArray(value.layers) || !value.layers.length || value.layers.length > 200) throw new Error("Lottie 需包含 1–200 个图层。");
  if (value.assets !== undefined && !Array.isArray(value.assets)) throw new Error("Lottie 资源格式无效。");
  for (const asset of (value.assets as Array<Record<string, unknown>> | undefined) ?? []) {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) throw new Error("Lottie 资源格式无效。");
    if (asset.u !== undefined && asset.u !== "") throw new Error("不能引用外部资源目录。");
    if (asset.p !== undefined && (typeof asset.p !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/i.test(asset.p))) throw new Error("只支持内嵌 PNG/JPEG/WebP，不能引用外部资源。");
  }
  const visit = (node: unknown, depth: number): void => {
    if (depth > 100) throw new Error("Lottie 嵌套超过上限。");
    if (typeof node === "number" && !Number.isFinite(node)) throw new Error("Lottie 包含无效数值。");
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Lottie 包含不支持的字段。");
      if (key === "x" && typeof child === "string") throw new Error("不支持 Lottie 表达式。");
      if (key === "fPath" && (typeof child !== "string" || child.trim())) throw new Error("不支持 Lottie 外部字体路径。");
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}
function validateSettings(value: Settings): void {
  if (value.version !== 1 || !Number.isFinite(value.sourceFr) || value.sourceFr <= 0 || value.sourceFr > 240 || !Number.isFinite(value.speed) || value.speed < 0.25 || value.speed > 4 || value.sourceFr * value.speed > 240 || !Number.isFinite(value.scale) || value.scale < 0.25 || value.scale > 4 || !Number.isFinite(value.opacity) || value.opacity < 0 || value.opacity > 1) throw new Error("速度/缩放必须在 0.25–4，透明度在 0–1，实际帧率不超过 240。");
}

/** Only top-level static transform properties are editable; animated keys are never replaced. */
function staticTransform(layer: unknown, key: "o" | "p" | "s" | "r" | "a"): { value: number | number[]; property: Record<string, unknown> } | null {
  if (!layer || typeof layer !== "object" || Array.isArray(layer)) return null;
  const transform = (layer as Record<string, unknown>).ks;
  if (!transform || typeof transform !== "object" || Array.isArray(transform)) return null;
  const property = (transform as Record<string, unknown>)[key];
  if (!property || typeof property !== "object" || Array.isArray(property)) return null;
  const field = property as Record<string, unknown>;
  if ((field.a !== undefined && field.a !== 0) || field.k === undefined || field.k === null) return null;
  const value = field.k;
  if (typeof value === "number") { if (!Number.isFinite(value)) return null; return { value, property: field }; }
  if (!Array.isArray(value) || value.length < 2 || value.length > 3 || !value.every(item => typeof item === "number" && Number.isFinite(item))) return null;
  return { value: [...value] as number[], property: field };
}

const layerOpacity = (layer: unknown) => {
  const field = staticTransform(layer, "o");
  return field && typeof field.value === "number" && field.value >= 0 && field.value <= 100 ? field : null;
};

function opacityKeyframes(layer: unknown): Array<Record<string, unknown>> | null {
  if (!layer || typeof layer !== "object" || Array.isArray(layer)) return null;
  const ks = (layer as Record<string, unknown>).ks;
  const field = ks && typeof ks === "object" && !Array.isArray(ks) ? (ks as Record<string, unknown>).o : null;
  if (!field || typeof field !== "object" || Array.isArray(field)) return null;
  const property = field as Record<string, unknown>;
  if (property.a !== 1 || !Array.isArray(property.k) || !property.k.length) return null;
  let previous = -Infinity;
  for (const key of property.k) {
    if (!key || typeof key !== "object" || Array.isArray(key) || typeof key.t !== "number" || !Number.isFinite(key.t) || key.t <= previous || !Array.isArray(key.s) || key.s.length !== 1 || typeof key.s[0] !== "number" || !Number.isFinite(key.s[0]) || key.s[0] < 0 || key.s[0] > 100) return null;
    if (key.e !== undefined && (!Array.isArray(key.e) || key.e.length !== 1 || typeof key.e[0] !== "number" || !Number.isFinite(key.e[0]) || key.e[0] < 0 || key.e[0] > 100)) return null;
    previous = key.t;
  }
  return property.k;
}

/** Animated position keyframes with plain 2D/3D values; split dimensions are never rewritten. */
function positionKeyframes(layer: unknown): Array<Record<string, unknown>> | null {
  if (!layer || typeof layer !== "object" || Array.isArray(layer)) return null;
  const ks = (layer as Record<string, unknown>).ks;
  const field = ks && typeof ks === "object" && !Array.isArray(ks) ? (ks as Record<string, unknown>).p : null;
  if (!field || typeof field !== "object" || Array.isArray(field)) return null;
  const property = field as Record<string, unknown>;
  if (property.x !== undefined || property.y !== undefined) return null;
  if (property.a !== 1 || !Array.isArray(property.k) || !property.k.length) return null;
  const uniform = (value: unknown): value is number[] => Array.isArray(value) && (value.length === 2 || value.length === 3) && value.every(item => typeof item === "number" && Number.isFinite(item));
  let previous = -Infinity;
  for (const key of property.k) {
    if (!key || typeof key !== "object" || Array.isArray(key) || typeof key.t !== "number" || !Number.isFinite(key.t) || key.t <= previous || !uniform(key.s)) return null;
    if (key.e !== undefined && !uniform(key.e)) return null;
    previous = key.t;
  }
  return property.k;
}

function staticShapeColor(layer: unknown, indices: number[], type: "fl" | "st"): { property: Record<string, unknown>; color: number[] } | null {
  if (!layer || typeof layer !== "object" || Array.isArray(layer)) return null;
  const entry = layer as Record<string, unknown>;
  if (entry.ty !== 4 || !Array.isArray(entry.shapes)) return null;
  let shapes: unknown[] = entry.shapes;
  for (let depth = 0; depth < indices.length; depth++) {
    const shape: unknown = shapes[indices[depth]!];
    if (!shape || typeof shape !== "object" || Array.isArray(shape)) return null;
    const item = shape as Record<string, unknown>;
    if (depth < indices.length - 1) {
      if (item.ty !== "gr" || !Array.isArray(item.it)) return null;
      shapes = item.it;
      continue;
    }
    if (item.ty !== type || !item.c || typeof item.c !== "object" || Array.isArray(item.c)) return null;
    const property = item.c as Record<string, unknown>, color = property.k;
    if ((property.a !== undefined && property.a !== 0) || !Array.isArray(color) || (color.length !== 3 && color.length !== 4) || !color.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1)) return null;
    return { property, color: [...color] };
  }
  return null;
}

function staticText(layer: unknown): Record<string, unknown> | null {
  if (!layer || typeof layer !== "object" || Array.isArray(layer)) return null;
  const entry = layer as Record<string, any>;
  if (entry.ty !== 5 || !entry.t || typeof entry.t !== "object" || Array.isArray(entry.t)) return null;
  const document = entry.t.d;
  if (!document || typeof document !== "object" || Array.isArray(document) || (document.a !== undefined && document.a !== 0) || !Array.isArray(document.k) || document.k.length !== 1) return null;
  const key = document.k[0];
  if (!key || typeof key !== "object" || Array.isArray(key) || !key.s || typeof key.s !== "object" || Array.isArray(key.s) || typeof key.s.t !== "string" || key.e !== undefined || key.h !== undefined) return null;
  return key.s as Record<string, unknown>;
}

// Match lottie-web 5.x TextProperty.buildFinalText, not Unicode grapheme segmentation.
function lottieTextCharacters(text: string): string[] {
  const combined = new Set([2304, 2305, 2306, 2307, 2362, 2363, 2364, 2366, 2367, 2368, 2369, 2370, 2371, 2372, 2373, 2374, 2375, 2376, 2377, 2378, 2379, 2380, 2381, 2382, 2383, 2387, 2388, 2389, 2390, 2391, 2402, 2403]);
  const result: string[] = [];
  let joinNext = false;
  for (let i = 0; i < text.length;) {
    const code = text.charCodeAt(i), point = text.codePointAt(i)!;
    let character = text[i]!, join = joinNext;
    joinNext = false;
    if (combined.has(code)) join = true;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const tags = Array.from({ length: 5 }, (_, n) => text.codePointAt(i + 2 + n * 2));
      if (point === 0x1f3f4 && tags.every(tag => tag !== undefined && tag >= 0xe0061 && tag <= 0xe007a) && text.codePointAt(i + 12) === 0xe007f) character = text.slice(i, i + 14);
      else if (point > 0xffff) {
        character = text.slice(i, i + 2);
        if (point >= 0x1f3fb && point <= 0x1f3ff) join = true;
        else if (point >= 0x1f1e6 && point <= 0x1f1ff) {
          const next = text.codePointAt(i + 2);
          if (next !== undefined && next >= 0x1f1e6 && next <= 0x1f1ff) character = text.slice(i, i + 4);
        }
      }
    } else if (code === 0xfe0f) join = true;
    else if (code === 0x200d) { join = true; joinNext = true; }
    if (join && result.length) result[result.length - 1] += character;
    else if (join) result.push(`undefined${character}`); // Mirrors lottie-web's leading combining character behavior.
    else result.push(character);
    i += character.length;
  }
  return result;
}

function validateTextGlyphs(source: Lottie, text: Record<string, unknown>, replacement: string): void {
  if (source.chars == null) return;
  if (!Array.isArray(source.chars)) throw new Error("Lottie 字形表格式无效，无法安全编辑文字。");
  const fonts = source.fonts && typeof source.fonts === "object" && !Array.isArray(source.fonts) ? (source.fonts as Record<string, unknown>).list : undefined;
  const font = Array.isArray(fonts) ? fonts.find(item => item && typeof item === "object" && !Array.isArray(item) && item.fName === text.f) : undefined;
  if (typeof text.f !== "string" || !font || typeof font.fFamily !== "string" || typeof font.fStyle !== "string") throw new Error("无法确定文字图层的字体名称、字体族和样式；不能验证 Lottie 字形表。");
  const glyphs = new Set(source.chars.filter(item => item && typeof item === "object" && !Array.isArray(item) && item.fFamily === font.fFamily && item.style === font.fStyle && typeof item.ch === "string").map(item => item.ch));
  const missing = [...new Set(lottieTextCharacters(replacement).filter(character => character.charCodeAt(0) !== 13 && character.charCodeAt(0) !== 3 && !glyphs.has(character)))];
  if (missing.length) throw new Error(`Lottie 字形表缺少字体 ${JSON.stringify(font.fFamily)}、样式 ${JSON.stringify(font.fStyle)} 的字形：${missing.map(character => JSON.stringify(character)).join("、")}；请使用已导出字形或重新导出包含所需文字的 Lottie。`);
}

function describeLayers(source: Lottie) {
  const format = (value: number | number[] | null) => Array.isArray(value) ? value.map(item => Number(item.toFixed(2))).join(",") : value;
  const shapeColors = (layer: unknown, type: "fl" | "st") => {
    if (!layer || typeof layer !== "object" || Array.isArray(layer)) return [];
    const entry = layer as Record<string, unknown>;
    if (entry.ty !== 4 || !Array.isArray(entry.shapes)) return [];
    const result: Array<{ path: string; color: number[] | null; editable: boolean }> = [];
    const visit = (shapes: unknown[], prefix: number[]) => shapes.forEach((shape, index) => {
      if (!shape || typeof shape !== "object" || Array.isArray(shape)) return;
      const item = shape as Record<string, unknown>, indices = [...prefix, index];
      if (item.ty === "gr" && Array.isArray(item.it)) visit(item.it, indices);
      if (item.ty === type) {
        const field = staticShapeColor(layer, indices, type);
        result.push({ path: indices.join("."), color: field?.color ?? null, editable: field !== null });
      }
    });
    visit(entry.shapes, []);
    return result;
  };
  return source.layers.map((layer, index) => ({
    index,
    name: layer && typeof layer === "object" && !Array.isArray(layer) && typeof (layer as Record<string, unknown>).nm === "string" ? (layer as Record<string, unknown>).nm : "",
    ...(layer && typeof layer === "object" && !Array.isArray(layer) && (layer as Record<string, unknown>).ty === 5 ? { text: staticText(layer)?.t ?? null, editableText: staticText(layer) !== null } : {}),
    opacity: layerOpacity(layer)?.value ?? null,
    anchor: format(staticTransform(layer, "a")?.value ?? null),
    position: format(staticTransform(layer, "p")?.value ?? null),
    scale: format(staticTransform(layer, "s")?.value ?? null),
    rotation: format(staticTransform(layer, "r")?.value ?? null),
    editableOpacity: layerOpacity(layer) !== null,
    ...(opacityKeyframes(layer) ? { opacityKeyframes: opacityKeyframes(layer)!.map((key, keyIndex) => ({ index: keyIndex, frame: key.t, value: (key.s as number[])[0] })) } : {}),
    ...(positionKeyframes(layer) ? { positionKeyframes: positionKeyframes(layer)!.map((key, keyIndex) => ({ index: keyIndex, frame: key.t, value: format([...(key.s as number[])]), editable: true })) } : {}),
    fills: shapeColors(layer, "fl"),
    strokes: shapeColors(layer, "st"),
  }));
}
export function buildLottieHtml(source: Lottie, options: Settings): string {
  validateLottie(source); validateSettings(options);
  if (Math.abs(source.fr - options.sourceFr) > 1e-9) throw new Error("Lottie 原始帧率不一致。");
  const data = { ...source, fr: options.sourceFr * options.speed };
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const marker = encodeURIComponent(JSON.stringify(options));
  return `<!--glint-lottie:${marker}-->${prefix}transform:scale(${options.scale});opacity:${options.opacity};transform-origin:center"></div><script>window.__glintLottie=${json};</script>`;
}
export function readImportedLottie(scene: HtmlScene): { source: Lottie; settings: Settings } {
  const match = markerPattern.exec(scene.html);
  const jsonMatch = /<script>window\.__glintLottie=([\s\S]*);<\/script>$/.exec(scene.html);
  if (!match || scene.animation !== "lottie") throw new Error("该镜头不是 Glint 导入的 Lottie；原 HTML 不会被覆盖。");
  if (!jsonMatch) throw new Error("Lottie 模板已损坏或被手动修改；原 HTML 不会被覆盖。");
  try {
    const settings = JSON.parse(decodeURIComponent(match[1]!)) as Settings; validateSettings(settings);
    const data = JSON.parse(jsonMatch[1]!) as Lottie;
    if (!Number.isFinite(data.fr) || Math.abs(data.fr - settings.sourceFr * settings.speed) > 1e-9) throw new Error("frame rate changed");
    const source = { ...data, fr: settings.sourceFr }; validateLottie(source);
    if (buildLottieHtml(source, settings) !== scene.html) throw new Error("content changed");
    return { source, settings };
  } catch { throw new Error("Lottie 模板已损坏或被手动修改；原 HTML 不会被覆盖。"); }
}

function readLottieFile(file: string, snapshot?: Buffer): Lottie {
  const stat = snapshot ? null : fs.statSync(file);
  if (stat && (!stat.isFile() || stat.size > maxBytes)) throw new Error("Lottie 文件必须是小于 256 KiB 的普通 JSON 文件。");
  const bytes = snapshot ?? fs.readFileSync(file);
  if (bytes.byteLength > maxBytes) throw new Error("Lottie 文件超过 256 KiB。");
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
  validateLottie(value);
  return value;
}

export function inspectLottieSource(file: string) {
  const source = readLottieFile(file);
  return { width: source.w, height: source.h, startFrame: source.ip, endFrame: source.op, sourceFr: source.fr, layers: describeLayers(source) };
}

export function inspectLottieScene(file: string, id: string) {
  const project = parseProject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file))));
  const scene = project.scenes.find(item => item.id === id);
  if (!scene || scene.kind !== "html") throw new Error("请选择已导入的 Lottie 镜头。");
  const { source, settings } = readImportedLottie(scene);
  return { width: source.w, height: source.h, startFrame: source.ip, endFrame: source.op, ...settings, layers: describeLayers(source) };
}

const maxAssetBytes = 8 * 1024 * 1024;
type AssetExtension = "png" | "jpg" | "webp";

/** Magic-number probe, not a full decoder; a data-URL label alone never earns library entry. */
export function imageMagic(bytes: Buffer): AssetExtension | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

function validateRaster(bytes: Buffer, ext: AssetExtension, index: number): void {
  // Reject common truncations that permissive decoders can otherwise conceal.
  const complete = ext === "png"
    ? bytes.length >= 20 && bytes.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex"))
    : ext === "jpg"
      ? bytes.length >= 4 && bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]))
      : bytes.length >= 12 && bytes.readUInt32LE(4) + 8 === bytes.length;
  if (!complete) throw new Error(`Lottie 资源 ${index} 图片已截断或格式无效，拒绝回库。`);
  // Fixed pipe input, explicit codec and protocol allowlist prevent external fetches.
  // Limit pixels before allocating a decoded frame; fail closed on missing ffmpeg or timeout.
  const decoder = { png: "png", jpg: "mjpeg", webp: "webp" }[ext];
  const result = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-max_pixels", "16777216", "-protocol_whitelist", "pipe", "-f", "image2pipe", "-c:v", decoder, "-i", "pipe:0", "-frames:v", "1", "-f", "framehash", "pipe:1"], { input: bytes, timeout: 15000, maxBuffer: 64 * 1024, windowsHide: true });
  if (result.error || result.status !== 0 || !/^0,\s*\d+/m.test(result.stdout?.toString("utf8") ?? "")) throw new Error(`Lottie 资源 ${index} 图片解码失败或解码器不可用，拒绝回库；请检查图片和本机 FFmpeg。`);
}

export type LottieAsset = { assetIds: string[]; mime: string; ext: AssetExtension; bytes: Buffer; sha256: string };

/** Embedded raster resources of a validated Lottie, deduplicated by content.
 * Precomposition assets carry no data URL and are skipped, never extracted or edited. */
export function extractLottieAssets(source: Lottie): LottieAsset[] {
  const found = new Map<string, LottieAsset>();
  const assets = (source.assets as Array<Record<string, unknown>> | undefined) ?? [];
  for (const [index, asset] of assets.entries()) {
    const value = asset?.p;
    if (typeof value !== "string" || !value) continue;
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/i.exec(value);
    if (!match) throw new Error(`Lottie 资源 ${index} 不是内嵌 PNG/JPEG/WebP 数据，拒绝回库。`);
    const bytes = Buffer.from(match[2]!, "base64");
    if (!bytes.length || bytes.length > maxAssetBytes) throw new Error(`Lottie 资源 ${index} 大小超出 1 B–8 MiB 范围，拒绝回库。`);
    const magic = imageMagic(bytes);
    const expected: AssetExtension = ({ png: "png", jpeg: "jpg", webp: "webp" } as const)[match[1]!.toLowerCase() as "png" | "jpeg" | "webp"];
    if (!magic || magic !== expected) throw new Error(`Lottie 资源 ${index} 的魔数与声明的 ${match[1]} 格式不符，拒绝回库。`);
    validateRaster(bytes, expected, index);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const assetId = typeof asset.id === "string" ? asset.id.slice(0, 100) : String(index);
    const existing = found.get(sha256);
    if (existing) { if (!existing.assetIds.includes(assetId)) existing.assetIds.push(assetId); continue; }
    found.set(sha256, { assetIds: [assetId], mime: `image/${match[1]!.toLowerCase()}`, ext: expected, bytes, sha256 });
  }
  return [...found.values()];
}

type AssetReceipt = { file: string; sha256: string; bytes: number; mime: string; assetIds: string[]; state: "created" | "verified" };
function assetName(asset: LottieAsset): string { return `lottie-${asset.sha256}.${asset.ext}`; }
function verifyExisting(target: string, asset: LottieAsset): boolean {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== asset.bytes.length || createHash("sha256").update(fs.readFileSync(target)).digest("hex") !== asset.sha256) {
    throw new Error(`素材库已存在同名文件 ${assetName(asset)} 但内容不一致，未覆盖；请人工核对后处理。`);
  }
  return true;
}

/** Write one verified asset into the library; content-addressed, exclusive, never overwriting. */
function restoreOneAsset(library: string, asset: LottieAsset, published: AssetReceipt[]): AssetReceipt {
  const name = assetName(asset), target = path.join(library, name), temporary = path.join(library, `.lottie-restore-${randomUUID()}.part`);
  let state: "created" | "verified" = "created";
  try {
    fs.writeFileSync(temporary, asset.bytes, { flag: "wx", mode: 0o600 });
    try {
      fs.linkSync(temporary, target);
      published.push({ file: name, sha256: asset.sha256, bytes: asset.bytes.length, mime: asset.mime, assetIds: asset.assetIds, state });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      state = "verified";
    }
    if (!verifyExisting(target, asset)) throw new Error(`素材 ${name} 在回库过程中消失。`);
    return { file: name, sha256: asset.sha256, bytes: asset.bytes.length, mime: asset.mime, assetIds: asset.assetIds, state };
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error; } }
}

/** 素材回库：把已导入镜头（或其编辑产物）的内嵌图片安全写回素材库。
 * 来源必须是经完整性校验的 Glint 导入场景；逐资源校验格式、大小和本地解码；
 * 按内容寻址独占写入，绝不覆盖；随后从工程引用回读核对哈希。 */
export function runLottieAssetRestore(args: string[]): void {
  const file = readArg(args, "project"), id = readArg(args, "scene"), saveAssets = readArg(args, "save-assets");
  if (args.length !== 3 || !file || !id || saveAssets === undefined) throw new Error("素材回库只接受 --project=<工程.json> --scene=<镜头ID> --save-assets=<素材库目录> 三个参数，不能与编辑参数组合。");
  const projectFile = fs.realpathSync(file);
  const parse = () => parseProject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(projectFile))));
  const scene = parse().scenes.find(item => item.id === id);
  if (!scene || scene.kind !== "html") throw new Error("请选择已导入的 Lottie 镜头。");
  if (scene.locked) throw new Error("Scene is locked；锁定镜头不能回库。");
  // 来源门禁：只信任通过导入完整性校验（标记+重序列化一致）的镜头。
  const { source } = readImportedLottie(scene);
  const assets = extractLottieAssets(source);
  const library = path.resolve(saveAssets);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(library); } catch { throw new Error("素材库目录不存在；请先创建，或指向媒体库目录（默认 GLINT_DATA_DIR/media 或 apps/studio/out/.media）。"); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("素材回库目标必须是已存在的普通目录。");
  const real = fs.realpathSync(library), directory = fs.statSync(real);
  const checkDirectory = () => {
    const current = fs.lstatSync(library), resolved = fs.statSync(real);
    if (current.isSymbolicLink() || !current.isDirectory() || fs.realpathSync(library) !== real || resolved.dev !== directory.dev || resolved.ino !== directory.ino) throw new Error("素材库目录在回库过程中被替换，已中止。");
  };
  // Preflight every destination before publishing anything. Races remain possible.
  checkDirectory();
  for (const asset of assets) verifyExisting(path.join(real, assetName(asset)), asset);
  const published: AssetReceipt[] = [], saved: AssetReceipt[] = [];
  try {
    for (const asset of assets) { checkDirectory(); saved.push(restoreOneAsset(real, asset, published)); checkDirectory(); }
    // Re-read the project, including its lock state, after publication.
    const sceneAgain = parse().scenes.find(item => item.id === id);
    if (!sceneAgain || sceneAgain.kind !== "html" || sceneAgain.locked) throw new Error("工程镜头已改变或锁定，回执作废。");
    if (sceneAgain.html !== scene.html) throw new Error("工程在回库过程中发生变化，回执作废。");
    for (const asset of assets) if (!verifyExisting(path.join(real, assetName(asset)), asset)) throw new Error(`素材 ${assetName(asset)} 在回库过程中消失。`);
  } catch (error) {
    // Never roll back target names: another process may already depend on or replace them.
    throw new Error(`素材回库未完成：${error instanceof Error ? error.message : String(error)}。已发布文件不自动删除，请人工核对；部分回执 ${JSON.stringify({ sceneId: id, library: real, published, verified: saved.filter(item => item.state === "verified") })}`);
  }
  console.log(JSON.stringify({
    sceneId: id, library: real, saved,
    note: assets.length ? "内嵌图片已按内容寻址回库；已从工程引用回读核对哈希。预合成结构与预合成编辑不在回库范围。" : "该镜头没有内嵌图片资源；预合成结构与外链资源不在回库范围。",
  }, null, 2));
}

export function runLottieImport(args: string[], snapshot?: { project: Buffer; source?: Buffer }): void {
  if (args.some(arg => arg.startsWith("--save-assets"))) { runLottieAssetRestore(args); return; }
  const inspectSource = readArg(args, "inspect-source");
  if (inspectSource !== undefined) {
    if (!inspectSource || args.length !== 1) throw new Error("导入前检查只接受 --inspect-source=<本地 Lottie JSON>，不能与其他参数组合。");
    const source = readLottieFile(inspectSource);
    console.log(JSON.stringify({ width: source.w, height: source.h, startFrame: source.ip, endFrame: source.op, sourceFr: source.fr, layers: describeLayers(source), note: "只检查受限导入格式，不执行动画；不保证完整 Lottie 兼容性。Web 不接受 HTML 场景。" }, null, 2));
    return;
  }
  const file = readArg(args, "project"), id = readArg(args, "scene"), outArg = readArg(args, "out"), input = readArg(args, "source"), append = args.includes("--append");
  if (!file || !id) throw new Error("lottie-import requires --project=<project.json> --scene=<id>");
  const projectFile = fs.realpathSync(file), parent = path.dirname(projectFile), project = parseProject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshot?.project ?? fs.readFileSync(projectFile))));
  const existing = project.scenes.find(scene => scene.id === id);
  const editing = append || input !== undefined || ["speed", "scale", "opacity", "layer-index", "layer-text", "layer-opacity", "layer-anchor", "layer-pos", "layer-scale", "layer-rotation", "fill-path", "fill-color", "stroke-path", "stroke-color", "opacity-keyframe", "keyframe-opacity", "keyframe-frame", "position-keyframe", "keyframe-pos"].some(key => readArg(args, key) !== undefined);
  if (!editing) {
    if (outArg) throw new Error("No changes requested; omit --out to inspect");
    if (!existing || existing.kind !== "html") throw new Error("Select an imported Lottie scene");
    const { source, settings } = readImportedLottie(existing);
    console.log(JSON.stringify({ sceneId: id, width: source.w, height: source.h, startFrame: source.ip, endFrame: source.op, ...settings, layers: describeLayers(source), note: "支持顶层静态文字、静态变换、形状静态填充和描边颜色及已有透明度关键帧值/时间与位置关键帧值；Web 不接受 HTML 场景。" }, null, 2)); return;
  }
  if (!outArg) throw new Error("Pass --out=<new project.json> beside the input project");
  if (append && existing) throw new Error("Scene id already exists");
  if (!append && (!existing || existing.kind !== "html")) throw new Error("Select an imported Lottie scene");
  if (existing?.locked) throw new Error("Scene is locked");
  if (append && !input) throw new Error("Pass --source=<local Lottie JSON> with --append");
  if (!append && input) throw new Error("Replacing source is not supported; append a new scene instead");
  let source: Lottie, prior: Settings;
  if (append) {
    if (snapshot && !snapshot.source) throw new Error("缺少素材快照，请刷新后重试。");
    source = readLottieFile(input!, snapshot?.source);
    prior = { version: 1, sourceFr: source.fr, speed: 1, scale: 1, opacity: 1 };
  } else ({ source, settings: prior } = readImportedLottie(existing as HtmlScene));
  const layerIndex = readArg(args, "layer-index"), layerAlpha = readArg(args, "layer-opacity"), layerText = readArg(args, "layer-text");
  const layerAnchor = readArg(args, "layer-anchor"), layerPos = readArg(args, "layer-pos"), layerScale = readArg(args, "layer-scale"), layerRotation = readArg(args, "layer-rotation");
  const fillPath = readArg(args, "fill-path"), fillColor = readArg(args, "fill-color"), strokePath = readArg(args, "stroke-path"), strokeColor = readArg(args, "stroke-color");
  const keyframeIndex = readArg(args, "opacity-keyframe"), keyframeOpacity = readArg(args, "keyframe-opacity"), keyframeFrame = readArg(args, "keyframe-frame");
  const positionKeyframeIndex = readArg(args, "position-keyframe"), keyframePos = readArg(args, "keyframe-pos");
  if (layerIndex !== undefined || layerText !== undefined || layerAlpha !== undefined || layerAnchor !== undefined || layerPos !== undefined || layerScale !== undefined || layerRotation !== undefined || fillPath !== undefined || fillColor !== undefined || strokePath !== undefined || strokeColor !== undefined || keyframeIndex !== undefined || keyframeOpacity !== undefined || keyframeFrame !== undefined || positionKeyframeIndex !== undefined || keyframePos !== undefined) {
    if (layerIndex === undefined || !/^(0|[1-9]\d*)$/.test(layerIndex) || (layerText === undefined && layerAlpha === undefined && layerAnchor === undefined && layerPos === undefined && layerScale === undefined && layerRotation === undefined && fillColor === undefined && fillPath === undefined && strokeColor === undefined && strokePath === undefined && keyframeIndex === undefined && keyframeOpacity === undefined && keyframeFrame === undefined && positionKeyframeIndex === undefined && keyframePos === undefined)) throw new Error("逐层编辑需要 --layer-index=<零起始索引> 与至少一个图层属性。");
    const index = Number(layerIndex);
    if (!Number.isSafeInteger(index) || index >= source.layers.length) throw new Error("图层索引超出范围。");
    if (layerText !== undefined) {
      if (Buffer.byteLength(layerText, "utf8") > maxTextBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(layerText)) throw new Error("文字不能超过 4096 字节或包含不支持的控制字符。");
      const text = staticText(source.layers[index]);
      if (!text) throw new Error("该图层没有可编辑的静态文字；文字关键帧或不支持的结构不会被覆盖。");
      validateTextGlyphs(source, text, layerText);
      text.t = layerText;
    }
    if (keyframeIndex !== undefined || keyframeOpacity !== undefined || keyframeFrame !== undefined) {
      if (layerAlpha !== undefined || keyframeIndex === undefined || !/^(0|[1-9]\d*)$/.test(keyframeIndex) || (keyframeOpacity === undefined && keyframeFrame === undefined)) throw new Error("关键帧编辑需要 --opacity-keyframe=<零起始索引> 和 --keyframe-opacity 或 --keyframe-frame，不能同时设置静态透明度。");
      const keyIndex = Number(keyframeIndex), keys = opacityKeyframes(source.layers[index]);
      if (!Number.isSafeInteger(keyIndex) || !keys || keyIndex >= keys.length) throw new Error("透明度关键帧格式或索引无效；原动画不会被覆盖。");
      const current = keys[keyIndex]!, previous = keys[keyIndex - 1], next = keys[keyIndex + 1];
      if (keyframeFrame !== undefined) {
        const frame = keyframeFrame.trim() ? Number(keyframeFrame) : NaN;
        if (!Number.isFinite(frame) || frame < source.ip || frame >= source.op || (previous && frame <= (previous.t as number)) || (next && frame >= (next.t as number))) throw new Error("关键帧时间须在动画范围内，且严格位于相邻关键帧之间。");
        current.t = frame;
      }
      if (keyframeOpacity !== undefined) {
        const opacity = keyframeOpacity.trim() ? Number(keyframeOpacity) : NaN;
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 100) throw new Error("透明度关键帧数值无效；原动画不会被覆盖。");
        if (previous?.e !== undefined && (previous.e as number[])[0] !== (current.s as number[])[0]) throw new Error("前一关键帧终值与目标起始值不一致，无法安全编辑。");
        current.s = [opacity];
        if (previous?.e !== undefined) previous.e = [opacity];
      }
    }
    for (const [type, rawPath, color, label] of [["fl", fillPath, fillColor, "fill"], ["st", strokePath, strokeColor, "stroke"]] as const) {
      if (rawPath === undefined && color === undefined) continue;
      if (rawPath === undefined || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*))*$/.test(rawPath) || color === undefined || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`${label} 编辑需要 --${label}-path=<形状索引路径> 和 --${label}-color=#RRGGBB。`);
      const indices = rawPath.split(".").map(Number);
      if (indices.length > 100 || !indices.every(Number.isSafeInteger)) throw new Error("形状路径超出范围。");
      const field = staticShapeColor(source.layers[index], indices, type);
      if (!field) throw new Error(`目标不是可编辑的静态${type === "fl" ? "填充" : "描边"}颜色；关键帧或不支持的形状不会被覆盖。`);
      const rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255);
      field.property.k = field.color.length === 4 ? [...rgb, field.color[3]] : rgb;
    }
    if (layerAlpha !== undefined) {
      if (!layerAlpha.trim()) throw new Error("请传入 --layer-opacity=<0..100>。");
      const opacity = Number(layerAlpha);
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 100) throw new Error("图层透明度超出范围。");
      const field = layerOpacity(source.layers[index]);
      if (!field) throw new Error("该图层没有可编辑的静态透明度；动画关键帧不会被覆盖。");
      field.property.k = opacity;
    }
    const pair = (raw: string, label: string, min: number, max: number): number[] => {
      if (!raw.trim()) throw new Error(`请传入 ${label}=<值,值>。`);
      const tokens = raw.split(",");
      if (tokens.length !== 2 || tokens.some(item => !item.trim())) throw new Error(`${label} 需要两个介于 ${min} 与 ${max} 之间的数值（逗号分隔）。`);
      const parts = tokens.map(item => Number(item));
      if (!parts.every(item => Number.isFinite(item)) || !parts.every(item => item >= min && item <= max)) throw new Error(`${label} 需要两个介于 ${min} 与 ${max} 之间的数值（逗号分隔）。`);
      return parts;
    };
    if (layerAnchor !== undefined) {
      const field = staticTransform(source.layers[index], "a");
      if (!field || !Array.isArray(field.value)) throw new Error("该图层没有可编辑的静态锚点；动画关键帧不会被覆盖。");
      const [x, y] = pair(layerAnchor, "--layer-anchor", -100000, 100000);
      field.property.k = field.value.length === 3 ? [x, y, field.value[2]] : [x, y];
    }
    if (layerPos !== undefined) {
      const field = staticTransform(source.layers[index], "p");
      if (!field || !Array.isArray(field.value)) throw new Error("该图层没有可编辑的静态位置；动画关键帧不会被覆盖。");
      const [x, y] = pair(layerPos, "--layer-pos", -100000, 100000);
      field.property.k = field.value.length === 3 ? [x, y, field.value[2]] : [x, y];
    }
    if (layerScale !== undefined) {
      const field = staticTransform(source.layers[index], "s");
      if (!field || !Array.isArray(field.value)) throw new Error("该图层没有可编辑的静态缩放；动画关键帧不会被覆盖。");
      const [sx, sy] = pair(layerScale, "--layer-scale", 1, 10000);
      field.property.k = field.value.length === 3 ? [sx, sy, field.value[2]] : [sx, sy];
    }
    if (layerRotation !== undefined) {
      if (!layerRotation.trim()) throw new Error("请传入 --layer-rotation=<角度>。");
      const rotation = Number(layerRotation);
      if (!Number.isFinite(rotation) || rotation < -3600 || rotation > 3600) throw new Error("图层旋转角度超出范围。");
      const field = staticTransform(source.layers[index], "r");
      if (!field || typeof field.value !== "number") throw new Error("该图层没有可编辑的静态旋转；动画关键帧不会被覆盖。");
      field.property.k = rotation;
    }
    if (positionKeyframeIndex !== undefined || keyframePos !== undefined) {
      if (layerPos !== undefined || positionKeyframeIndex === undefined || !/^(0|[1-9]\d*)$/.test(positionKeyframeIndex) || keyframePos === undefined) throw new Error("位置关键帧编辑需要 --position-keyframe=<零起始索引> 与 --keyframe-pos=<x,y>，不能同时设置静态位置。");
      const keyIndex = Number(positionKeyframeIndex), keys = positionKeyframes(source.layers[index]);
      if (!Number.isSafeInteger(keyIndex) || !keys || keyIndex >= keys.length) throw new Error("位置关键帧格式或索引无效；原动画不会被覆盖。");
      const [x, y] = pair(keyframePos, "--keyframe-pos", -100000, 100000);
      const current = keys[keyIndex]!, start = current.s as number[], previous = keys[keyIndex - 1];
      const value = start.length === 3 ? [x, y, start[2]!] : [x, y];
      if (previous?.e !== undefined) {
        const end = previous.e as number[];
        if (end.length !== start.length || end[0] !== start[0] || end[1] !== start[1]) throw new Error("前一关键帧终值与目标起始值不一致，无法安全编辑。");
        previous.e = value;
      }
      current.s = value;
    }
  }
  const number = (key: string, previous: number) => { const arg = readArg(args, key); return arg === undefined ? previous : arg.trim() ? Number(arg) : NaN; };
  const settings: Settings = { ...prior, speed: number("speed", prior.speed), scale: number("scale", prior.scale), opacity: number("opacity", prior.opacity) };
  const html = buildLottieHtml(source, settings), duration = Math.ceil((source.op - source.ip) / source.fr / settings.speed * 1000);
  if (duration > 600000) throw new Error("调整后动画超过 10 分钟。");
  if (append) project.scenes.push({ id, kind: "html", html, animation: "lottie", narration: { text: "Lottie 动画素材", durationMs: Math.max(100, duration) } });
  else {
    if (duration > sceneDurationMs(existing!)) throw new Error("调整后动画超过当前镜长；先调整镜长或提高速度。");
    (existing as HtmlScene).html = html;
  }
  const output = path.resolve(outArg);
  if (fs.realpathSync(path.dirname(output)) !== parent) throw new Error("Output must be beside the input project so relative assets remain valid");
  fs.writeFileSync(output, JSON.stringify(parseProject(project), null, 2) + "\n", { flag: "wx" });
  console.log(`[glint] Lottie 已写入新工程：${output}`);
}
