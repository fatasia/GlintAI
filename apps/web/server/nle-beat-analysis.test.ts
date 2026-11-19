import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { makeBeatFixture } from "./beat-fixture";
// @ts-expect-error JavaScript beat module.
import { estimateBeatGrids } from "./nle-beat-calibration.mjs";
// @ts-expect-error JavaScript beat module.
import { analyzeNleAudioBeats } from "./nle-beat-analysis.mjs";
// @ts-expect-error JavaScript server exercised via HTTP.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

it.skipIf(process.env.GLINT_REAL_BEAT_SAMPLES !== "1")("inspects existing music without asserting unlabelled ground truth", async () => {
  const sources = ["evidence/GEN-05/run-20261024-music/generated.mp3", "outputs/xin-qiji-20261023/.preflight-runtime/assets/project-GuhroU/music.wav"];
  for (const source of sources) {
    const fullPath = path.resolve(source), name = fullPath.endsWith(".wav") ? "music.wav" : "music.mp3";
    const value = await analyzeNleAudioBeats({ name, startMs: 30_000, durationMs: 20_000, media: { asset: () => fullPath }, signal: new AbortController().signal });
    expect(value.calibration.candidates.length).toBeGreaterThan(0);
    console.info(JSON.stringify({ source, peaks: value.beatsMs.length, calibration: value.calibration }));
  }
}, 60_000);

it("reports periodic alternatives and refuses insufficient or invalid peaks", () => {
  for (const bpm of [72, 90, 120, 137, 176]) {
    const period = 60_000 / bpm, peaks = Array.from({ length: 24 }, (_, i) => 175 + i * period);
    const result = estimateBeatGrids(peaks, 30_000);
    expect(result.status).toBe("candidates");
    expect(result.candidates.some((candidate: { bpm: number; offsetMs: number }) => Math.abs(candidate.bpm - bpm) <= 0.6 && Math.abs(candidate.offsetMs - 175) < 40)).toBe(true);
  }
  const irregular = estimateBeatGrids([110, 480, 1220, 1490, 2420, 2800, 3890, 4770, 5100, 6380, 7910, 8440], 10_000);
  expect(irregular.status).toBe("ambiguous");
  expect(estimateBeatGrids([], 4000).status).toBe("insufficient");
  expect(estimateBeatGrids([0, 10, 20, 30, 40, 50], 4000).status).toBe("insufficient");
  for (const bad of [[0, 0], [100, 50], [NaN], [-1], [4000]]) expect(() => estimateBeatGrids(bad, 4000)).toThrow();
  expect(() => estimateBeatGrids([], Infinity)).toThrow();
});

it("keeps in-range half and double tempo hypotheses within the five ranked candidates", () => {
  for (const bpm of [72, 100, 120, 176]) {
    const period = 60_000 / bpm;
    const result = estimateBeatGrids(Array.from({ length: 24 }, (_, i) => 175 + i * period), 30_000);
    const best = result.candidates[0];
    expect(result.candidates.length).toBeLessThanOrEqual(5);
    for (const target of [best.bpm / 2, best.bpm * 2]) {
      if (target >= 60 && target <= 200) {
        expect(result.candidates.some((item: { bpm: number }) => Math.abs(item.bpm - target) <= 0.21), JSON.stringify(result)).toBe(true);
      }
    }
    for (let i = 1; i < result.candidates.length; i++) expect(result.candidates[i - 1].alignment).toBeGreaterThanOrEqual(result.candidates[i].alignment);
    expect(result.candidates.every((item: { bpm: number }) => item.bpm >= 60 && item.bpm <= 200)).toBe(true);
  }
  const halfSpeed = estimateBeatGrids(Array.from({ length: 24 }, (_, i) => 175 + i * 500), 30_000);
  expect(halfSpeed.candidates.some((item: { bpm: number }) => Math.abs(item.bpm - 60) <= 0.2)).toBe(true);
  const doubleSpeed = estimateBeatGrids(Array.from({ length: 18 }, (_, i) => 175 + i * 1000), 30_000);
  expect(doubleSpeed.candidates.some((item: { bpm: number }) => Math.abs(item.bpm - 120) <= 0.2)).toBe(true);
  const irregular = estimateBeatGrids([110, 480, 1220, 1490, 2420, 2800, 3890, 4770, 5100, 6380, 7910, 8440], 10_000);
  expect(irregular.status).toBe("ambiguous");
});

it("analyzes trimmed audio from the library with real FFmpeg and rejects unsafe sources", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-beat-http-")), media = path.join(root, "media"); fs.mkdirSync(media);
  const audio = makeBeatFixture(); fs.writeFileSync(path.join(media, "clicks.wav"), audio); fs.writeFileSync(path.join(media, "silence.wav"), makeBeatFixture(true));
  for (const bpm of [90, 137, 176]) fs.writeFileSync(path.join(media, `click${bpm}.wav`), makeBeatFixture(false, bpm));
  fs.writeFileSync(path.join(media, "broken.wav"), "not audio");
  const jobs = createMediaJobs(media, {}), server = createWebServer({ mediaJobs: jobs, requestLogDir: path.join(root, "logs") }) as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/nle/beats`;
    const send = (body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    for (const body of [{ name: "../clicks.wav", startMs: 0, durationMs: 4000 }, { name: "clicks.wav", startMs: -1, durationMs: 4000 }, { name: "clicks.wav", startMs: 0, durationMs: 120001 }]) expect((await send(body)).status).toBe(400);
    const response = await send({ name: "clicks.wav", startMs: 1000, durationMs: 4000 }), value = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(200);
    expect(value.scope).toBe("estimated-energy-peaks"); expect(value.sourceSha256).toBe(createHash("sha256").update(audio).digest("hex"));
    expect(value.bpm).toBeGreaterThan(118); expect(value.bpm).toBeLessThan(122);
    expect(value.calibration.status).toBe("candidates");
    expect(value.calibration.candidates.some((item: { bpm: number; offsetMs: number }) => Math.abs(item.bpm - 120) < 1 && Math.abs(item.offsetMs - 200) < 20)).toBe(true);
    expect(value.beatsMs.length).toBe(8);
    for (const [index, beat] of (value.beatsMs as number[]).entries()) expect(Math.abs(beat - (200 + index * 500))).toBeLessThanOrEqual(20);
    const quiet = await (await send({ name: "silence.wav", startMs: 0, durationMs: 4000 })).json(); expect(quiet.bpm).toBe(0); expect(quiet.beatsMs).toEqual([]); expect(quiet.calibration.status).toBe("insufficient");
    for (const bpm of [90, 137, 176]) {
      const response = await send({ name: `click${bpm}.wav`, startMs: 0, durationMs: 8000 });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      expect(result.calibration.candidates.some((item: { bpm: number; offsetMs: number }) => Math.abs(item.bpm - bpm) < 1.5 && Math.abs(item.offsetMs - 200) < 50), JSON.stringify(result.calibration)).toBe(true);
    }
    expect((await send({ name: "missing.wav", startMs: 0, durationMs: 4000 })).status).toBe(404);
    expect((await send({ name: "broken.wav", startMs: 0, durationMs: 4000 })).ok).toBe(false);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    const realRoot = fs.realpathSync(root), temp = fs.realpathSync(os.tmpdir());
    if (path.dirname(realRoot) !== temp || !path.basename(realRoot).startsWith("glint-beat-http-")) throw new Error("Unexpected temporary directory");
    fs.rmSync(realRoot, { recursive: true, force: true });
  }
}, 60_000);
