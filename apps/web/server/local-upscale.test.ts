import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync, spawn } from "node:child_process";
import { expect, it, vi } from "vitest";
import { createLocalUpscale } from "./local-upscale.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aWQAAAAASUVORK5CYII=", "base64");
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-upscale-test-"));
  fs.writeFileSync(path.join(dir, "realesrgan-x4plus.param"), "test");
  fs.writeFileSync(path.join(dir, "realesrgan-x4plus.bin"), "test");
  return dir;
}
function cleanup(dir: string) {
  if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unsafe test path");
  for (const suffix of ["param", "bin"]) fs.unlinkSync(path.join(dir, `realesrgan-x4plus.${suffix}`));
  fs.rmdirSync(dir);
}
function fakeSpawn({ wrongSize = false, hold = false, onRuntime = () => {} }: { wrongSize?: boolean; hold?: boolean; onRuntime?: () => void } = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn = vi.fn((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn(() => { queueMicrotask(() => child.emit("close", null)); return true; }) });
    queueMicrotask(() => {
      if (command === process.execPath) {
        onRuntime(); if (hold) return;
        fs.writeFileSync(args[args.indexOf("-o") + 1]!, png);
      }
      if (command === "ffprobe") {
        const result = args.at(-1)?.endsWith("output.png"), size = result ? (wrongSize ? 7 : 8) : 2;
        child.stdout.write(JSON.stringify({ streams: [{ codec_type: "video", codec_name: "png", width: size, height: size }] }));
      }
      child.stdout.end(); child.emit("close", 0);
    });
    return child;
  });
  return { spawn, calls };
}

it("requires explicit absolute executable and real model files", () => {
  expect(createLocalUpscale({ executable: "relative", modelDir: "relative" }).configured()).toBe(false);
  const dir = fixture();
  try { expect(createLocalUpscale({ executable: process.execPath, modelDir: dir }).configured()).toBe(true); }
  finally { cleanup(dir); }
});

it("checks source and output via ffprobe and decoding and only accepts exact 4× PNG", async () => {
  const dir = fixture(), fake = fakeSpawn();
  try {
    const worker = createLocalUpscale({ executable: process.execPath, modelDir: dir, spawnImpl: fake.spawn });
    expect(await worker.run(png, new AbortController().signal)).toEqual(png);
    expect(fake.calls.map(item => item.command)).toEqual(["ffprobe", "ffmpeg", process.execPath, "ffprobe", "ffmpeg"]);
    const runtime = fake.calls[2]!;
    expect(runtime.args).toContain("realesrgan-x4plus"); expect(runtime.args).toContain("4");
    expect(fs.existsSync(runtime.args[runtime.args.indexOf("-i") + 1]!)).toBe(false);
    await expect(worker.run(Buffer.from("not an image"), new AbortController().signal)).rejects.toThrow(/PNG/);
    const wrong = fakeSpawn({ wrongSize: true });
    await expect(createLocalUpscale({ executable: process.execPath, modelDir: dir, spawnImpl: wrong.spawn }).run(png, new AbortController().signal)).rejects.toThrow(/4 倍/);
  } finally { cleanup(dir); }
});

it("normalizes synthetic JPEG EXIF orientations before 4× processing", async () => {
  const dir = fixture();
  const source = path.join(dir, "fixture.jpg"), output = path.join(dir, "result.png");
  try {
    // Four different corners distinguish rotations from every mirrored orientation.
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=80x40,drawbox=x=40:y=0:w=40:h=20:color=green:t=fill,drawbox=x=0:y=20:w=40:h=20:color=blue:t=fill,drawbox=x=40:y=20:w=40:h=20:color=yellow:t=fill", "-frames:v", "1", source]);
    const jpg = fs.readFileSync(source);
    const withOrientation = (orientation: number, bigEndian: boolean) => {
      const exif = Buffer.from(bigEndian
        ? "4578696600004d4d002a00000008000101120003000000010000000000000000"
        : "45786966000049492a0008000000010012010300010000000000000000000000", "hex");
      if (bigEndian) exif.writeUInt16BE(orientation, 24); else exif.writeUInt16LE(orientation, 24);
      const header = Buffer.alloc(4); header.writeUInt16BE(0xffe1, 0); header.writeUInt16BE(exif.length + 2, 2);
      return Buffer.concat([jpg.subarray(0, 2), header, exif, jpg.subarray(2)]);
    };
    const runtimeInputs: string[] = [];
    const worker = createLocalUpscale({ executable: process.execPath, modelDir: dir, spawnImpl: (command: string, args: string[], options: object) => {
      if (command !== process.execPath) return spawn(command, args, options);
      const input = args[args.indexOf("-i") + 1]!, target = args[args.indexOf("-o") + 1]!;
      runtimeInputs.push(input);
      return spawn("ffmpeg", ["-v", "error", "-i", input, "-vf", "scale=iw*4:ih*4", "-frames:v", "1", target], options);
    } });
    for (const bigEndian of [false, true]) for (const [orientation, width, height, corners] of [
      [1, 320, 160, ["red", "green", "blue", "yellow"]],
      [2, 320, 160, ["green", "red", "yellow", "blue"]],
      [3, 320, 160, ["yellow", "blue", "green", "red"]],
      [4, 320, 160, ["blue", "yellow", "red", "green"]],
      [5, 160, 320, ["red", "blue", "green", "yellow"]],
      [6, 160, 320, ["blue", "red", "yellow", "green"]],
      [7, 160, 320, ["yellow", "green", "blue", "red"]],
      [8, 160, 320, ["green", "yellow", "red", "blue"]],
    ] as const) {
      const result = await worker.run(withOrientation(orientation, bigEndian), new AbortController().signal);
      fs.writeFileSync(output, result);
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", output], { encoding: "utf8" }));
      expect(probe.streams[0]).toMatchObject({ width, height });
      const pixels = execFileSync("ffmpeg", ["-v", "error", "-i", output, "-pix_fmt", "rgb24", "-frames:v", "1", "-f", "rawvideo", "-"]);
      const classify = (x: number, y: number) => {
        const i = (y * width + x) * 3, r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!;
        if (r > 150 && g > 150 && b < 100) return "yellow";
        if (r > g * 2 && r > b * 2) return "red";
        if (b > r * 2 && b > g * 2) return "blue";
        if (g > r * 2 && g > b * 2) return "green";
        return `unknown(${r},${g},${b})`;
      };
      expect([classify(20, 20), classify(width - 21, 20), classify(20, height - 21), classify(width - 21, height - 21)], `orientation ${orientation}`).toEqual(corners);
      fs.unlinkSync(output);
    }
    expect(runtimeInputs).toHaveLength(16);
    expect(runtimeInputs.every(input => input.endsWith("oriented.png") && !fs.existsSync(input))).toBe(true);
    const app1 = (payload: Buffer) => {
      const header = Buffer.alloc(4); header.writeUInt16BE(0xffe1); header.writeUInt16BE(payload.length + 2, 2);
      return Buffer.concat([jpg.subarray(0, 2), header, payload, jpg.subarray(2)]);
    };
    const invalidOrientation = withOrientation(9, false);
    const duplicate = withOrientation(6, false);
    const secondExif = duplicate.subarray(2, 38);
    const conflicting = Buffer.concat([duplicate.subarray(0, 2), secondExif, duplicate.subarray(2)]);
    const malformed = withOrientation(6, false); malformed.writeUInt32LE(0xffffffff, 16);
    for (const bad of [invalidOrientation, conflicting, malformed, app1(Buffer.from("http://ns.adobe.com/xap/1.0/\0<tiff:Orientation>6</tiff:Orientation>")), Buffer.concat([jpg, Buffer.from([0])])]) {
      await expect(worker.run(bad, new AbortController().signal)).rejects.toThrow(/JPEG/);
    }
    expect(runtimeInputs).toHaveLength(16);
    await expect(worker.run(Buffer.from([0xff, 0xd8, 0xff, 0]), new AbortController().signal)).rejects.toThrow();
  } finally {
    for (const file of [source, output]) if (fs.existsSync(file)) fs.unlinkSync(file);
    cleanup(dir);
  }
}, 90_000);

it("safely rejects transparent WebP EXIF orientations and preserves metadata-free alpha", async () => {
  const dir = fixture(), raw = path.join(dir, "rgba.raw"), webp = path.join(dir, "input.webp"), output = path.join(dir, "output.png");
  const rgba = Buffer.alloc(16 * 12 * 4);
  for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) {
    const i = (y * 16 + x) * 4;
    rgba[i] = x < 8 ? 255 : 0; rgba[i + 2] = x < 8 ? 0 : 255; rgba[i + 3] = y < 4 ? 0 : y < 8 ? 128 : 255;
  }
  const chunk = (name: string, data: Buffer) => {
    const header = Buffer.alloc(8); header.write(name, 0, 4, "ascii"); header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const wrap = (chunks: Buffer[]) => {
    const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
    const header = Buffer.alloc(8); header.write("RIFF"); header.writeUInt32LE(body.length, 4);
    return Buffer.concat([header, body]);
  };
  let calls = 0, runtimeCalls = 0;
  const worker = createLocalUpscale({ executable: process.execPath, modelDir: dir, spawnImpl: (command: string, args: string[], options: object) => {
    calls++;
    if (command !== process.execPath) return spawn(command, args, options);
    runtimeCalls++;
    return spawn("ffmpeg", ["-v", "error", "-i", args[args.indexOf("-i") + 1]!, "-vf", "scale=iw*4:ih*4:flags=neighbor", "-frames:v", "1", args[args.indexOf("-o") + 1]!], options);
  } });
  try {
    fs.writeFileSync(raw, rgba);
    for (const lossless of [true, false]) {
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "16x12", "-i", raw, "-frames:v", "1", "-c:v", "libwebp", "-lossless", lossless ? "1" : "0", webp]);
      const base = fs.readFileSync(webp);
      const decoded = await worker.run(base, new AbortController().signal);
      fs.writeFileSync(output, decoded);
      const pixels = execFileSync("ffmpeg", ["-v", "error", "-i", output, "-pix_fmt", "rgba", "-f", "rawvideo", "-"]);
      expect(pixels.length).toBe(64 * 48 * 4);
      expect(pixels[(2 * 64 + 2) * 4 + 3]).toBe(0);
      expect(pixels[(20 * 64 + 2) * 4 + 3]).toBeGreaterThan(0);
      expect(pixels[(20 * 64 + 2) * 4 + 3]).toBeLessThan(255);
      expect(pixels[(44 * 64 + 2) * 4 + 3]).toBeGreaterThanOrEqual(254);
      // TIFF EXIF payload with the actual orientation tag.
      for (let orientation = 1; orientation <= 8; orientation++) {
        const exif = Buffer.from("49492a0008000000010012010300010000000000000000000000", "hex"); exif.writeUInt16LE(orientation, 18);
        const hasExtended = base.toString("ascii", 12, 16) === "VP8X";
        const vp8x = hasExtended ? Buffer.from(base.subarray(20, 30)) : Buffer.from([0x10, 0, 0, 0, 15, 0, 0, 11, 0, 0]);
        vp8x[0] = vp8x[0]! | 0x08;
        const metadata = wrap([chunk("VP8X", vp8x), base.subarray(hasExtended ? 30 : 12), chunk("EXIF", exif)]);
        const before = calls;
        await expect(worker.run(metadata, new AbortController().signal)).rejects.toThrow(/另存为不含元数据的静态 PNG/);
        // Exercise the chunk scan even if the container omits the metadata flag.
        if (orientation === 6) {
          vp8x[0] = vp8x[0]! & ~0x08;
          await expect(worker.run(wrap([chunk("VP8X", vp8x), base.subarray(hasExtended ? 30 : 12), chunk("EXIF", exif)]), new AbortController().signal)).rejects.toThrow(/另存为不含元数据的静态 PNG/);
        }
        expect(calls).toBe(before);
      }
      fs.unlinkSync(output);
    }
    expect(runtimeCalls).toBe(2);
    for (const extra of [chunk("XMP ", Buffer.from("<x/>")), chunk("ANIM", Buffer.alloc(6)), chunk("ANMF", Buffer.alloc(16))]) {
      await expect(worker.run(wrap([extra]), new AbortController().signal)).rejects.toThrow(/另存为不含元数据的静态 PNG/);
    }
    const flagged = Buffer.alloc(10); flagged[0] = 8;
    await expect(worker.run(wrap([chunk("VP8X", flagged)]), new AbortController().signal)).rejects.toThrow(/另存为不含元数据的静态 PNG/);
    const truncated = wrap([chunk("EXIF", Buffer.from("x"))]).subarray(0, 21);
    const malformedChunk = wrap([Buffer.from("5650384cffffffff", "hex")]);
    for (const input of [truncated, malformedChunk, Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.from("x")])]) {
      await expect(worker.run(input, new AbortController().signal)).rejects.toThrow(/结构无效/);
    }
    const abort = new AbortController(); abort.abort();
    await expect(worker.run(fs.readFileSync(webp), abort.signal)).rejects.toThrow();
  } finally {
    for (const file of [raw, webp, output]) if (fs.existsSync(file)) fs.unlinkSync(file);
    cleanup(dir);
  }
}, 90_000);

it("rejects PNG orientation metadata and malformed chunk boundaries before launching a decoder", async () => {
  const dir = fixture(), fake = fakeSpawn();
  const chunk = (type: string, data: Buffer) => {
    const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); result.write(type, 4, "ascii"); data.copy(result, 8); return result;
  };
  const insert = (data: Buffer) => Buffer.concat([png.subarray(0, 33), data, png.subarray(33)]);
  const worker = createLocalUpscale({ executable: process.execPath, modelDir: dir, spawnImpl: fake.spawn });
  try {
    for (let orientation = 1; orientation <= 8; orientation++) {
      const exif = Buffer.from("49492a0008000000010012010300010000000000000000000000", "hex");
      exif.writeUInt16LE(orientation, 18);
      await expect(worker.run(insert(chunk("eXIf", exif)), new AbortController().signal)).rejects.toThrow(/方向相关元数据/);
    }
    for (const type of ["tEXt", "zTXt", "iTXt"]) {
      await expect(worker.run(insert(chunk(type, Buffer.from("XML:com.adobe.xmp\0orientation"))), new AbortController().signal)).rejects.toThrow(/方向相关元数据/);
    }
    for (const input of [png.subarray(0, 20), Buffer.concat([png, Buffer.from([0])]), insert(chunk("tEXt", Buffer.from("no delimiter"))), insert(Buffer.from("ffffffff74455874", "hex"))]) {
      await expect(worker.run(input, new AbortController().signal)).rejects.toThrow(/结构无效/);
    }
    expect(fake.calls).toHaveLength(0);
    expect(await worker.run(insert(chunk("tEXt", Buffer.from("Comment\0synthetic"))), new AbortController().signal)).toEqual(png);
  } finally { cleanup(dir); }
});

it("rejects real animated PNG and animation chunks with actionable guidance before decoding", async () => {
  const dir = fixture(), input = path.join(dir, "animation.png"), fake = fakeSpawn();
  try {
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x32:rate=2", "-frames:v", "2", "-plays", "0", "-f", "apng", input]);
    const worker = createLocalUpscale({ executable: process.execPath, modelDir: dir, spawnImpl: fake.spawn });
    await expect(worker.run(fs.readFileSync(input), new AbortController().signal)).rejects.toThrow(/动画 PNG.*静态帧/);
    for (const name of ["acTL", "fcTL", "fdAT"]) {
      const chunk = Buffer.alloc(12); chunk.write(name, 4, "ascii");
      const image = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
      await expect(worker.run(image, new AbortController().signal)).rejects.toThrow(/动画 PNG.*静态帧/);
    }
    expect(fake.calls).toHaveLength(0);
    expect(await worker.run(png, new AbortController().signal)).toEqual(png);
  } finally {
    if (fs.existsSync(input)) fs.unlinkSync(input);
    cleanup(dir);
  }
});

it("aborts only its own runtime process and waits for close before cleanup", async () => {
  const dir = fixture(), abort = new AbortController(); let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const fake = fakeSpawn({ hold: true, onRuntime: started });
  try {
    const work = createLocalUpscale({ executable: process.execPath, modelDir: dir, spawnImpl: fake.spawn }).run(png, abort.signal);
    await ready; abort.abort(); await expect(work).rejects.toThrow();
    const runtime = fake.calls[2]!;
    expect(fs.existsSync(runtime.args[runtime.args.indexOf("-i") + 1]!)).toBe(false);
  } finally { cleanup(dir); }
});
