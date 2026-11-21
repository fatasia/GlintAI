import { nleRenderDurationMs } from "./nle-render-options.ts";

/**
 * V-04a: attaches a technical verification receipt (verifyExport) to the NLE
 * render receipt. The whole request keeps the single 300 s ceiling the client
 * and the render timer already enforce — verification only gets whatever
 * budget rendering left over, so timeouts never stack serially. A failed or
 * cancelled verification never blocks the download; it only downgrades
 * `verify.pass` with controlled reasons.
 */
export const NLE_RENDER_BUDGET_MS = 300_000;

/** Wraps a NLE video renderer so its successful receipt carries `verify`. */
export function verifyNleRenderer(renderer, verifier) {
  return async (options) => {
    const startedAt = Date.now();
    const result = await renderer(options);
    const { outputPath, ...receipt } = result ?? {};
    // K-03: actual wall time (render + verification), so plan previews can be
    // compared with what execution really took.
    return { ...receipt, elapsedMs: Date.now() - startedAt, verify: await runVerification(outputPath, options, verifier, startedAt) };
  };
}

async function runVerification(outputPath, options, verifier, startedAt) {
  if (typeof outputPath !== "string" || !outputPath)
    return { pass: false, sha256: null, bytes: 0, checks: [], remainingChecks: [], error: "unavailable" };
  const remaining = NLE_RENDER_BUDGET_MS - (Date.now() - startedAt);
  const signals = [options?.signal, AbortSignal.timeout(Math.max(remaining, 0))].filter(Boolean);
  try {
    const report = await verifier({
      videoPath: outputPath,
      expect: {
        width: options.project.width,
        height: options.project.height,
        fps: options.project.fps,
        durationMs: nleRenderDurationMs(options.project),
      },
      audio: projectHasAudio(options.project) ? "required" : "optional",
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    });
    return toVerifyReceipt(report);
  } catch {
    // Controlled enum only: verifier errors can carry local paths or subprocess output.
    return { pass: false, sha256: null, bytes: 0, checks: [], remainingChecks: [], error: "failed" };
  }
}

function projectHasAudio(project) {
  return Boolean(project?.tracks?.some((track) =>
    track.clips?.some((clip) => clip.kind === "audio"),
  ));
}

/** Client-safe shape: check names and flags only — details can contain paths. */
function toVerifyReceipt(report) {
  return {
    pass: report?.pass === true,
    sha256: report?.sha256 ?? null,
    bytes: report?.bytes ?? 0,
    ...(typeof report?.duration === "number" ? { duration: report.duration } : {}),
    checks: (Array.isArray(report?.checks) ? report.checks : []).map((check) => ({
      name: String(check?.name ?? "unknown"),
      pass: check?.pass === true,
    })),
    remainingChecks: (Array.isArray(report?.remainingChecks) ? report.remainingChecks : []).map(String),
  };
}
