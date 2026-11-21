import { describe, expect, it } from "vitest";
import { verifyNleRenderer } from "./nle-render-verify.mjs";

// K-03: the wrapped receipt carries the actual wall time so previews can be
// compared with execution; verification failures never hide elapsedMs.
describe("verifyNleRenderer", () => {
  it("attaches elapsedMs and a passing verify to a successful render", async () => {
    const renderer = verifyNleRenderer(async () => ({ id: "x", file: "x.mp4", bytes: 10, url: "/u", outputPath: "/tmp/x.mp4" }), async () => ({ pass: true, sha256: "a".repeat(64), bytes: 10, checks: [], remainingChecks: [] }));
    const receipt = await renderer({ project: { width: 1920, height: 1080, fps: 30, tracks: [{ id: "track", kind: "video", name: "画面", clips: [] }] } });
    expect(receipt.id).toBe("x");
    expect(receipt.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(receipt.elapsedMs)).toBe(true);
    expect(receipt.verify.pass).toBe(true);
    expect(receipt.outputPath).toBeUndefined();
  });

  it("still reports elapsedMs when verification fails outright", async () => {
    const renderer = verifyNleRenderer(async () => ({ file: "x.mp4", outputPath: "/tmp/x.mp4" }), async () => { throw new Error("verifier down"); });
    const receipt = await renderer({ project: { width: 1920, height: 1080, fps: 30 } });
    expect(receipt.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(receipt.verify.pass).toBe(false);
    expect(receipt.verify.error).toBe("failed");
  });
});
