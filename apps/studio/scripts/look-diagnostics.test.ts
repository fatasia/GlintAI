import { expect, it } from "vitest";
import { captureLook, parseLookDiagnostics } from "./look-diagnostics";

it("retains intervals, closes trailing silence and distinguishes sample risk from true peak", () => {
  const report = parseLookDiagnostics("black_start:0 black_end:0.7 black_duration:0.7\nsilence_start: 0\nsilence_end: 1\nsilence_start: 2\nPeak level dB: -0.05", 3, true);
  expect(report.black).toEqual([{ start: 0, end: 0.7 }]);
  expect(report.silence).toEqual([{ start: 0, end: 1 }, { start: 2, end: 3 }]);
  expect(report.nearFullScale).toBe(true);
  expect(report.note).toContain("not proof");
  expect(parseLookDiagnostics("", 3, false)).toMatchObject({ audio: "absent", samplePeakDbfs: null, nearFullScale: false });
});

it("rejects cancellation and bounded diagnostic overflow", async () => {
  const controller = new AbortController(); controller.abort();
  expect(() => captureLook(process.execPath, [], controller.signal)).toThrow();
  await expect(captureLook(process.execPath, ["-e", "process.stdout.write('a'.repeat(5*1024*1024))"])).rejects.toThrow("4 MiB");
});

it("terminates a running child on cancellation and reports invalid media commands", async () => {
  const controller = new AbortController();
  const pending = captureLook(process.execPath, ["-e", "setInterval(()=>{},1000)"], controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow("cancelled");
  await expect(captureLook(process.execPath, ["-e", "process.exit(3)"])).rejects.toThrow("failed (3)");
});
