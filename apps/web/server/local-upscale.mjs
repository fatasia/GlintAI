import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_INPUT = 4 * 1024 * 1024, MAX_OUTPUT = 32 * 1024 * 1024;
const MODEL = "realesrgan-x4plus";

// Trust JPEG orientation only when the primary EXIF directory is unambiguous.
// FFmpeg silently ignores malformed values and some other orientation metadata.
function validateJpeg(input) {
  const invalid = () => { throw new Error("JPEG 文件结构或方向元数据无效，请按正确方向另存后重试。"); };
  const unsupported = () => { throw new Error("JPEG 含无法安全确认的方向元数据，请按正确方向另存为不含元数据的图片后重试。"); };
  let offset = 2, seenExif = false, inScan = false, ended = false;
  while (offset < input.length) {
    if (input[offset++] !== 0xff) { if (inScan) continue; invalid(); }
    while (input[offset] === 0xff) offset++;
    if (offset >= input.length) invalid();
    const marker = input[offset++];
    if (inScan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    inScan = false;
    if (marker === 0xd9) { ended = true; break; }
    if (marker === 0xd8 || marker === 0 || (marker >= 0xd0 && marker <= 0xd7)) invalid();
    if (marker === 0x01) continue;
    if (offset + 2 > input.length) invalid();
    const size = input.readUInt16BE(offset), end = offset + size;
    if (size < 2 || end > input.length) invalid();
    if (marker === 0xe1) {
      if (seenExif || !input.subarray(offset + 2, offset + 8).equals(Buffer.from("Exif\0\0"))) unsupported();
      seenExif = true;
      const tiff = input.subarray(offset + 8, end);
      if (tiff.length < 8) invalid();
      const order = tiff.toString("ascii", 0, 2);
      if (order !== "II" && order !== "MM") invalid();
      const u16 = pos => order === "II" ? tiff.readUInt16LE(pos) : tiff.readUInt16BE(pos);
      const u32 = pos => order === "II" ? tiff.readUInt32LE(pos) : tiff.readUInt32BE(pos);
      if (u16(2) !== 42) invalid();
      const ifd = u32(4);
      if (ifd < 8 || ifd + 2 > tiff.length) invalid();
      const count = u16(ifd), directoryEnd = ifd + 2 + count * 12;
      if (directoryEnd + 4 > tiff.length) invalid();
      let orientationSeen = false;
      for (let pos = ifd + 2; pos < directoryEnd; pos += 12) {
        if (u16(pos) !== 0x0112) continue;
        if (orientationSeen || u16(pos + 2) !== 3 || u32(pos + 4) !== 1 || u16(pos + 8) < 1 || u16(pos + 8) > 8) invalid();
        orientationSeen = true;
      }
    }
    offset = end;
    if (marker === 0xda) inScan = true;
  }
  if (!ended || offset !== input.length) invalid();
}

// PNG decoders may ignore eXIf or XMP orientation; never silently change display orientation.
function validatePng(input) {
  const invalid = () => { throw new Error("PNG 文件结构无效，请重新导出图片后重试。"); };
  const unsupported = () => { throw new Error("PNG 含方向相关元数据，无法安全处理；请先按正确方向另存为不含元数据的 PNG 后重试。"); };
  const animated = () => { throw new Error("不支持动画 PNG；请先导出所需的静态帧后重试。"); };
  let offset = 8, ended = false;
  while (offset < input.length) {
    if (input.length - offset < 12) invalid();
    const size = input.readUInt32BE(offset), end = offset + 12 + size;
    if (end > input.length) invalid();
    const type = input.toString("ascii", offset + 4, offset + 8);
    if (type === "eXIf") unsupported();
    if (["acTL", "fcTL", "fdAT"].includes(type)) animated();
    if (["tEXt", "zTXt", "iTXt"].includes(type)) {
      const text = input.subarray(offset + 8, offset + 8 + size), zero = text.indexOf(0);
      if (zero < 1 || zero > 79) invalid();
      if (/xmp|exif/i.test(text.toString("latin1", 0, zero))) unsupported();
    }
    offset = end;
    if (type === "IEND") { if (size !== 0 || offset !== input.length) invalid(); ended = true; break; }
  }
  if (!ended) invalid();
}

// RIFF chunks have a little-endian size and are padded to even byte boundaries.
// FFmpeg's WebP decoder does not reliably apply metadata orientation. Fail closed
// rather than producing an apparently valid but incorrectly oriented result.
function validateWebp(input) {
  const invalid = () => { throw new Error("WebP 文件结构无效，请重新导出图片后重试。"); };
  const unsupported = () => { throw new Error("WebP 含方向相关元数据或动画，无法安全处理；请先按正确方向另存为不含元数据的静态 PNG 后重试。"); };
  if (input.length < 12 || input.readUInt32LE(4) !== input.length - 8) invalid();
  let offset = 12, extended = false;
  while (offset < input.length) {
    if (input.length - offset < 8) invalid();
    const name = input.toString("ascii", offset, offset + 4), size = input.readUInt32LE(offset + 4);
    const end = offset + 8 + size, next = end + (size % 2);
    if (next > input.length) invalid();
    if (name === "EXIF" || name === "XMP " || name === "ANIM" || name === "ANMF") unsupported();
    if (name === "VP8X") {
      if (extended || offset !== 12 || size !== 10) invalid();
      extended = true;
      if (input[offset + 8] & 0x0e) unsupported();
    }
    offset = next;
  }
}

/** A private process is always awaited before its files can be removed. */
function execute(command, args, signal, timeoutMs, spawnImpl) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawnImpl(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, shell: false });
    let output = "", failure;
    const stop = () => child.kill();
    const timer = setTimeout(() => { failure = new Error("本地超分处理超时。"); stop(); }, timeoutMs);
    signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
    child.stdout.on("data", chunk => { output += String(chunk); if (output.length > 65536) { failure = new Error("图像信息超出限制。"); stop(); } });
    child.once("error", () => { failure = new Error("本地超分运行程序或图片校验工具不可用。"); });
    child.once("close", code => {
      clearTimeout(timer); signal.removeEventListener("abort", stop);
      if (signal.aborted) return reject(signal.reason ?? new Error("处理已取消。"));
      if (failure || code !== 0) return reject(failure ?? new Error("本地超分或图片解码失败，请检查运行环境。"));
      resolve(output);
    });
  });
}

/** Local optional Real-ESRGAN NCNN process. Configuration is trusted server state. */
export function createLocalUpscale({ executable = process.env.GLINT_UPSCALE_EXECUTABLE, modelDir = process.env.GLINT_UPSCALE_MODEL_DIR, spawnImpl = spawn } = {}) {
  const configured = () => {
    try {
      return typeof executable === "string" && path.isAbsolute(executable) && fs.statSync(executable).isFile() &&
        typeof modelDir === "string" && path.isAbsolute(modelDir) && fs.statSync(modelDir).isDirectory() &&
        ["param", "bin"].every(ext => fs.statSync(path.join(modelDir, `${MODEL}.${ext}`)).isFile());
    } catch { return false; }
  };
  async function dimensions(file, codec, signal) {
    const raw = await execute("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "json", file], signal, 30000, spawnImpl);
    let info; try { info = JSON.parse(raw); } catch { throw new Error("图片信息无效。"); }
    const image = info.streams?.find(item => item.codec_type === "video");
    if (!image || image.codec_name !== codec || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 || image.width > 4096 || image.height > 4096 || image.width * image.height > 16_777_216) throw new Error("图片格式或尺寸无效。");
    await execute("ffmpeg", ["-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-i", file, "-frames:v", "1", "-f", "null", "-"], signal, 30000, spawnImpl);
    return { width: image.width, height: image.height };
  }
  return {
    configured,
    async run(input, signal) {
      if (!configured()) throw new Error("未配置本地 Real-ESRGAN 运行程序和模型。");
      if (!Buffer.isBuffer(input) || !input.length || input.length > MAX_INPUT) throw new Error("图片必须小于 4 MiB。");
      const extension = input.subarray(0, 8).equals(PNG) ? "png" : input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff ? "jpg" : input.subarray(0, 4).toString() === "RIFF" && input.subarray(8, 12).toString() === "WEBP" ? "webp" : null;
      if (!extension) throw new Error("仅支持 PNG、JPEG 或 WebP 图片。");
      if (extension === "png") validatePng(input);
      if (extension === "jpg") validateJpeg(input);
      if (extension === "webp") validateWebp(input);
      signal.throwIfAborted();
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "glint-ai-upscale-"));
      const source = path.join(directory, `input.${extension}`), normalized = path.join(directory, "oriented.png"), result = path.join(directory, "output.png");
      try {
        fs.writeFileSync(source, input, { flag: "wx", mode: 0o600 });
        let original = await dimensions(source, { png: "png", jpg: "mjpeg", webp: "webp" }[extension], signal);
        if (original.width * original.height > 1_048_576 || original.width * 4 > 4096 || original.height * 4 > 4096) throw new Error("4× 超分输出不能超过 4096 像素/边或 1600 万像素，请缩小原图。");
        // The NCNN decoder ignores JPEG EXIF orientation; normalize it before inference.
        let inferenceSource = source;
        if (extension === "jpg") {
          await execute("ffmpeg", ["-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-i", source, "-frames:v", "1", "-map_metadata", "-1", normalized], signal, 30000, spawnImpl);
          original = await dimensions(normalized, "png", signal);
          inferenceSource = normalized;
        }
        await execute(executable, ["-i", inferenceSource, "-o", result, "-m", modelDir, "-n", MODEL, "-s", "4", "-f", "png", "-j", "1:1:1"], signal, 120000, spawnImpl);
        const stat = fs.lstatSync(result);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 8 || stat.size > MAX_OUTPUT) throw new Error("超分输出文件无效或过大。");
        const bytes = fs.readFileSync(result);
        if (!bytes.subarray(0, 8).equals(PNG)) throw new Error("超分输出不是 PNG。");
        const actual = await dimensions(result, "png", signal);
        if (actual.width !== original.width * 4 || actual.height !== original.height * 4) throw new Error("超分输出尺寸不是原图的 4 倍。");
        return bytes;
      } finally {
        for (const file of [source, normalized, result]) { try { fs.unlinkSync(file); } catch (e) { if (e?.code !== "ENOENT") throw e; } }
        try { fs.rmdirSync(directory); } catch (e) { if (e?.code !== "ENOENT" && e?.code !== "ENOTEMPTY") throw e; }
      }
    },
  };
}
