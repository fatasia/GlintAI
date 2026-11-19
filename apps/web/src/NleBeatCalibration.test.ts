// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { NleBeatCalibration, parseBeatCalibration } from "./NleBeatCalibration";

const candidate = { bpm: 120, offsetMs: 100, alignment: 0.9, matchedPeaks: 8, medianErrorMs: 2 };
it("validates optional calibration without treating alignment as probability", () => {
  expect(parseBeatCalibration({ status: "candidates", reason: "试听", candidates: [candidate] }, 4000)?.candidates).toEqual([candidate]);
  expect(parseBeatCalibration({ status: "insufficient", reason: "不足", candidates: [] }, 4000)?.status).toBe("insufficient");
  for (const bad of [null, {}, { status: "candidates", reason: "x", candidates: [] }, { status: "candidates", reason: "x", candidates: [{ ...candidate, bpm: Infinity }] }, { status: "ambiguous", reason: "x", candidates: [{ ...candidate, offsetMs: 4000 }] }, { status: "candidates", reason: "x", candidates: [{ ...candidate, alignment: 2 }] }]) expect(parseBeatCalibration(bad, 4000)).toBeNull();
});

it("requires a choice and exposes the long-film limitation before applying an editable grid", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), apply = vi.fn();
  const props = { calibration: { status: "candidates" as const, reason: "试听", candidates: [candidate] }, clip: { src: "assets/a.wav", startMs: 1000, trimStartMs: 0, durationMs: 4000, signature: "a" }, onApply: apply, button: {} };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => root.render(createElement(NleBeatCalibration, props)));
    expect(container.textContent).toContain("长片、变速或复杂音乐可能逐渐偏离");
    const buttons = container.querySelectorAll("button");
    expect(buttons[1]!.disabled).toBe(true);
    await act(async () => (container.querySelector('input[type="radio"]') as HTMLInputElement).click());
    await act(async () => buttons[1]!.click());
    expect(apply).toHaveBeenCalledWith({ bpm: 120, offsetMs: 1100, subdivisions: 1 });
    await act(async () => root.render(createElement(NleBeatCalibration, { ...props, clip: { ...props.clip, signature: "changed" } })));
    expect((container.querySelectorAll("button")[1] as HTMLButtonElement).disabled).toBe(true);
  } finally { await act(async () => root.unmount()); container.remove(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; }
});
