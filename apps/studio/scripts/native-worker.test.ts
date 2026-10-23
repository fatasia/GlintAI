import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { parseWorkerRequest } from "./native-worker";
import { qaSampleInterval } from "./qa";
import { startPngEncoder } from "./native-process";

describe("native worker request safety", () => {
  it("rejects duplicate ids and credentials in messages", () => {
    const seen = new Set<string>();
    expect(parseWorkerRequest({ id: "job-1", args: ["--tts=mock"] }, seen).id).toBe("job-1");
    expect(() => parseWorkerRequest({ id: "job-1", args: [] }, seen)).toThrow("duplicate");
    expect(() => parseWorkerRequest({ id: "job-2", args: ["--api-key=secret"] }, seen)).toThrow("Credentials");
  });
  it.each([null, { id: "../bad", args: [] }, { id: "x", args: [2] }, { id: "x", args: Array(41).fill("--fast") }])("rejects malformed request", value => expect(() => parseWorkerRequest(value, new Set())).toThrow());
});

describe("adaptive QA sampling", () => {
  it("samples short clips densely while keeping long-clip cost bounded", () => {
    expect(qaSampleInterval(2.5, 24)).toBe(0.3125);
    expect(qaSampleInterval(60, 30)).toBe(2.5);
    expect(qaSampleInterval(0.04, 30)).toBe(1 / 30);
    expect(() => qaSampleInterval(0, 30)).toThrow();
  });
});

describe("streaming PNG encoder", () => {
  it("produces a valid mp4 from in-memory frames without temp directories", async () => {
    const root = path.join(os.tmpdir(), `glint-encoder-${Date.now()}`); fs.mkdirSync(root, { recursive: true });
    const output = path.join(root, "out.mp4");
    try {
      const encoder = startPngEncoder({ fps: 10, crf: 24, preset: "veryfast", output });
      for (let i = 0; i < 6; i++) {
        const shade = i * 40;
        await encoder.write(new Uint8Array(new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="36"><rect width="64" height="36" fill="rgb(${shade},${shade},80)"/></svg>`).render().asPng()));
      }
      await encoder.finish();
      const probe = (await import("node:child_process")).execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", output]).toString().trim();
      expect(Number(probe)).toBeGreaterThanOrEqual(0.55);
      expect(fs.existsSync(output)).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 60000);
});