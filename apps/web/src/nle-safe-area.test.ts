import { describe, expect, it } from "vitest";
import { safeAreaInsets } from "./nle-safe-area";

describe("TEAM-04 safe area", () => {
  it("gives vertical platforms the largest reserved bands", () => {
    const vertical = safeAreaInsets({ width: 1080, height: 1920 });
    const landscape = safeAreaInsets({ width: 1920, height: 1080 });
    expect(vertical.bottom).toBeGreaterThan(landscape.bottom);
    expect(vertical.top).toBeGreaterThan(landscape.top);
    for (const value of Object.values(vertical)) expect(value).toBeGreaterThan(0);
  });
  it("keeps every inset below a quarter of the frame", () => {
    for (const size of [{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, { width: 1080, height: 1080 }]) {
      for (const value of Object.values(safeAreaInsets(size))) expect(value).toBeLessThan(0.25);
    }
  });
});
