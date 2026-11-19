import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

/** Probe only the child created for this upload; cancellation never scans processes. */
function imageTool(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let stdout = "", failure;
    const stop = () => { child.kill(); };
    const timer = setTimeout(() => { failure = new Error("Image validation timed out"); stop(); }, 30_000);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on("data", chunk => { stdout += String(chunk); if (stdout.length > 65536) { failure = new Error("Image metadata exceeds limit"); stop(); } });
    child.once("error", error => { failure = error; });
    child.once("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", stop);
      if (signal?.aborted) return reject(signal.reason ?? new Error("Upload cancelled"));
      if (failure || code !== 0) return reject(failure ?? new Error("Image decode failed"));
      resolve(stdout);
    });
  });
}

/** Ingest gate: a generated result must decode and carry the streams its media
 * type promises before it may enter the library; a broken file is refused and
 * removed so the library never serves an asset the renderer cannot open.
 * Fail-open when ffprobe is unavailable (it is a hard render dependency). */
export function probeIngest(file, type) {
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", file], { timeout: 30_000, encoding: "utf8", windowsHide: true });
  if (probe.error && probe.error.code === "ENOENT") return null;
  if (probe.error || probe.status !== 0) return "ffprobe could not decode the file; the gateway result is broken";
  let info;
  try { info = JSON.parse(probe.stdout); } catch { return "unreadable probe output"; }
  const streams = Array.isArray(info.streams) ? info.streams : [];
  const has = kind => streams.some(stream => stream.codec_type === kind);
  const duration = Number(info.format?.duration);
  if (type === "video" && (!has("video") || !(duration > 0))) return "no decodable video stream";
  if (type === "audio" && (!has("audio") || !(duration > 0))) return "no decodable audio stream";
  if (type === "image" && !streams.length) return "not recognized as an image";
  return null;
}

/** Everything that moves bytes into the library root; paths never leave it. */
export function createLibraryWriter(root) {
  const realRoot = fs.realpathSync(root);
  return {
    /** Stream an upload into the library; never buffers the whole body in memory. */
    async upload(stream, name, maxBytes = 300 * 1024 * 1024) {
      if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,100}\.mp4$/.test(name)) throw new Error("Upload name must be a safe .mp4 file name");
      const destination = path.join(root, name);
      if (fs.existsSync(destination)) throw new Error("Upload name already exists");
      const temporary = path.join(root, `.incoming-${randomUUID()}-${name}`);
      let bytes = 0;
      const limiter = new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > maxBytes) { done(Object.assign(new Error("Reference upload is too large"), { status: 413 })); return; }
        done(null, chunk);
      } });
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try {
        await pipeline(stream, limiter, fs.createWriteStream(temporary, { fd: descriptor, autoClose: true }));
        if (bytes < 1) throw Object.assign(new Error("Reference upload is empty"), { status: 400 });
        const rejected = probeIngest(temporary, "video");
        if (rejected) throw Object.assign(new Error(`Reference upload is not a decodable video: ${rejected}`), { status: 400 });
        if (fs.realpathSync(root) !== realRoot) throw new Error("Media library changed");
        // Publish only validated bytes. An arrival after the initial existence
        // check must never be replaced (rename replaces files on POSIX).
        fs.linkSync(temporary, destination);
        fs.unlinkSync(temporary);
        return { name, bytes };
      } catch (error) {
        try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort cleanup */ }
        throw error;
      }
    },
    /** Accept a bounded image stream; names are generated and existing files are never overwritten. */
    async uploadImage(stream, contentType, signal) {
      const types = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
      const extension = Object.hasOwn(types, contentType) ? types[contentType] : undefined;
      if (!extension) throw new Error("Only PNG, JPEG and WebP are supported");
      if (fs.realpathSync(root) !== realRoot) throw new Error("Media library changed");
      const id = randomUUID(), temporary = path.join(root, `.incoming-image-${id}.part`), name = `import-${id}.${extension}`;
      const destination = path.join(root, name); let bytes = 0;
      const limiter = new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) return done(Object.assign(new Error("Image exceeds 8 MiB"), { status: 413 }));
        done(null, chunk);
      } });
      // The file is exclusively created before streaming; cleanup owns this path.
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try {
        await pipeline(stream, limiter, fs.createWriteStream(temporary, { fd: descriptor, autoClose: true }), { signal });
        if (!bytes) throw new Error("Image is empty");
        const input = fs.readFileSync(temporary);
        const actual = input.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "png" :
          input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff ? "jpg" :
          input.subarray(0, 4).toString() === "RIFF" && input.subarray(8, 12).toString() === "WEBP" ? "webp" : null;
        if (actual !== extension) throw new Error("Image format does not match its content");
        const raw = await imageTool("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "json", temporary], signal);
        const info = JSON.parse(raw), image = info.streams?.find(item => item.codec_type === "video");
        const expectedCodec = { png: "png", jpg: "mjpeg", webp: "webp" }[extension];
        if (!image || image.codec_name !== expectedCodec || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.width > 8192 || image.height > 8192 || image.width * image.height > 16_777_216) throw new Error("Image dimensions or format invalid");
        await imageTool("ffmpeg", ["-v", "error", "-xerror", "-i", temporary, "-frames:v", "1", "-f", "null", "-"], signal);
        if (signal?.aborted) throw signal.reason ?? new Error("Upload cancelled");
        if (fs.realpathSync(root) !== realRoot) throw new Error("Media library changed");
        fs.linkSync(temporary, destination); // Atomic publish, never replaces an existing file.
        return { name, bytes, width: image.width, height: image.height };
      } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; } }
    },
    /** Copy an existing local file into the library under a fresh safe name. */
    install(source, name) {
      if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp|mp4|mp3|wav)$/.test(name)) throw new Error("Invalid media name");
      if (typeof source !== "string" || !path.isAbsolute(source)) throw new Error("Source must be an absolute path");
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Source must be a regular file");
      const destination = path.join(root, name);
      if (fs.existsSync(destination)) throw new Error("Media name already exists");
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      return name;
    },
  };
}
