import fs from "node:fs";
import { checkDelivery, type DeliveryCheckReport } from "./delivery-check";

/** Declared export specification the produced file is asserted against. */
export interface ExportExpectation {
  width?: number;
  height?: number;
  fps?: number;
  durationMs?: number;
  durationToleranceMs?: number;
}

export interface VerifyExportInput {
  videoPath: string;
  expect?: ExportExpectation;
  audio?: "required" | "optional" | "forbidden";
  targetLufs?: number;
  toleranceLu?: number;
  maxTruePeakDbtp?: number;
  signal?: AbortSignal;
}

export interface VerifyExportReport extends DeliveryCheckReport {
  container: { family: string; brandOk: boolean };
  expect: ExportExpectation;
  /** Automated verification cannot watch, listen or play; these stay with the human reviewer. */
  remainingChecks: string[];
}

const FAMILIES: Record<string, { brandOffset: number; brand: Buffer }> = {
  ".mp4": { brandOffset: 4, brand: Buffer.from("ftyp") },
  ".m4v": { brandOffset: 4, brand: Buffer.from("ftyp") },
  ".mov": { brandOffset: 4, brand: Buffer.from("ftyp") },
  ".webm": { brandOffset: 0, brand: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]) },
  ".mkv": { brandOffset: 0, brand: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]) },
  ".ogv": { brandOffset: 0, brand: Buffer.from("OggS") },
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const DEFAULT_DURATION_TOLERANCE_MS = 250;

/** Verifies a produced export against its declared specification. Decoding, loudness and
 * hash/unchanged guarantees come from the shared delivery engine; this layer adds container
 * branding and spec assertions, and always states what automation did not check. */
export async function verifyExport(input: VerifyExportInput): Promise<VerifyExportReport> {
  const expect = input.expect ?? {};
  const report = await checkDelivery({
    videoPath: input.videoPath,
    audio: input.audio,
    targetLufs: input.targetLufs,
    toleranceLu: input.toleranceLu,
    maxTruePeakDbtp: input.maxTruePeakDbtp,
    signal: input.signal,
  }) as VerifyExportReport;
  report.expect = expect;
  report.container = { family: "unknown", brandOk: false };
  report.remainingChecks = [
    "打开成片完整观看一遍：画面内容、剪辑点与节奏未由本工具评估",
    "含音频时人耳试听：响度数值不代表听感与口画同步质量",
    "在目标播放器或实机设备上播放一次再交付",
  ];
  const check = (name: string, pass: boolean, detail: string) => { report.checks.push({ name, pass, detail }); };
  const finish = () => { report.pass = report.checks.length > 0 && report.checks.every(item => item.pass); return report; };
  // Delivery failed before producing any usable result (bad input, no probe) — spec checks add nothing.
  if (!report.pass && !report.checks.some(item => item.pass)) return finish();

  const extension = input.videoPath.slice(input.videoPath.lastIndexOf(".")).toLowerCase();
  const family = FAMILIES[extension];
  if (!family) return finish();
  report.container.family = extension.slice(1);
  try {
    const handle = await fs.promises.open(input.videoPath, "r");
    try {
      const head = Buffer.alloc(family.brandOffset + 4);
      await handle.read(head, 0, head.length, 0);
      report.container.brandOk = head.subarray(family.brandOffset).equals(family.brand);
      check("container", report.container.brandOk, report.container.brandOk ? `${report.container.family} container signature present` : `Missing ${report.container.family} container signature`);
    } finally { await handle.close(); }
  } catch (error) {
    check("container", false, message(error));
  }

  const video = report.streams.find(stream => stream.type === "video");
  if (expect.width !== undefined) {
    const pass = video?.width === expect.width;
    check("spec:width", pass, `Expected width ${expect.width}, got ${video?.width ?? "unknown"}`);
  }
  if (expect.height !== undefined) {
    const pass = video?.height === expect.height;
    check("spec:height", pass, `Expected height ${expect.height}, got ${video?.height ?? "unknown"}`);
  }
  if (expect.fps !== undefined) {
    const fps = video?.fps;
    const pass = fps !== undefined && Math.abs(fps - expect.fps) <= 0.05;
    check("spec:fps", pass, `Expected ${expect.fps} fps, got ${fps ?? "unknown"}`);
  }
  if (expect.durationMs !== undefined) {
    const tolerance = expect.durationToleranceMs ?? DEFAULT_DURATION_TOLERANCE_MS;
    const actualMs = (report.duration ?? 0) * 1000;
    const delta = Math.abs(actualMs - expect.durationMs);
    const pass = Number.isFinite(actualMs) && actualMs > 0 && delta <= tolerance;
    check("spec:duration", pass, `Expected ${expect.durationMs} ms ± ${tolerance}, got ${Math.round(actualMs)} ms`);
  }
  return finish();
}

/** Prints one JSON report, including invalid arguments; never writes an output file. */
export async function runVerifyExport(args: string[]): Promise<VerifyExportReport> {
  let report: VerifyExportReport;
  try {
    const values = new Map<string, string>();
    const allowed = ["video", "expect-width", "expect-height", "expect-fps", "expect-duration-ms", "duration-tolerance-ms",
      "audio-policy", "audio", "target-lufs", "tolerance-lu", "max-true-peak-dbtp"];
    for (const arg of args) {
      const match = /^--([^=]+)=(.*)$/s.exec(arg);
      if (!match || !allowed.includes(match[1]!) || values.has(match[1]!) || !match[2]?.trim()) throw new Error(`Invalid or duplicate verify-export argument: ${arg}`);
      values.set(match[1]!, match[2]!);
    }
    if (values.has("audio-policy") && values.has("audio")) throw new Error("Provide only --audio-policy or --audio, not both");
    const number = (key: string) => values.has(key) ? Number(values.get(key)) : undefined;
    for (const key of ["expect-width", "expect-height", "expect-fps", "expect-duration-ms", "duration-tolerance-ms", "target-lufs", "tolerance-lu", "max-true-peak-dbtp"]) {
      if (values.has(key) && !Number.isFinite(number(key))) throw new Error(`--${key} must be a finite number`);
    }
    const expect = {
      width: number("expect-width"), height: number("expect-height"),
      fps: number("expect-fps"), durationMs: number("expect-duration-ms"),
      durationToleranceMs: number("duration-tolerance-ms"),
    };
    report = await verifyExport({
      videoPath: values.get("video") ?? "",
      expect: Object.values(expect).some(value => value !== undefined) ? expect : undefined,
      audio: (values.get("audio-policy") ?? values.get("audio")) as VerifyExportInput["audio"],
      targetLufs: number("target-lufs"), toleranceLu: number("tolerance-lu"), maxTruePeakDbtp: number("max-true-peak-dbtp"),
    });
  } catch (error) {
    report = {
      pass: false, checks: [{ name: "arguments", pass: false, detail: message(error) }],
      sha256: null, bytes: 0, streams: [],
      container: { family: "unknown", brandOk: false }, expect: {}, remainingChecks: [],
    };
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 2;
  return report;
}
