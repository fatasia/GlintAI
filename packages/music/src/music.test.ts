import { expect, it } from "vitest";
import { generateAmbientMusic } from "./index";
it.each([0, -1, NaN, Infinity])("rejects invalid duration %s", async (duration) => { await expect(generateAmbientMusic(duration)).rejects.toThrow("durationMs"); });
it.each([-1, NaN, Infinity, 2])("rejects invalid gain %s", async (gain) => { await expect(generateAmbientMusic(1000, { gain })).rejects.toThrow("gain"); });
it.each([0, -1, NaN, Infinity, 300001])("rejects invalid timeout %s", async (timeoutMs) => { await expect(generateAmbientMusic(1000, { timeoutMs })).rejects.toThrow("timeoutMs"); });
it("rejects unknown/inherited mood", async () => { await expect(generateAmbientMusic(1000, { mood: "toString" as "calm" })).rejects.toThrow("Unknown mood"); });
