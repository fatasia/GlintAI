import type { NleProject } from "@glintai/scenescript";
import { appFetch } from "./app-url";
import { t } from "./ui/i18n";
import { nleRenderOptions } from "../server/nle-render-options";
export type RenderMotion = { motionSamples: number; shutterAngle: number };
/** Server-side technical verification summary (V-04a): controlled names only. */
export type NleVerifyReceipt = {
  pass: boolean;
  sha256: string | null;
  bytes: number;
  duration?: number;
  checks: { name: string; pass: boolean }[];
  remainingChecks: string[];
  error?: string;
};
export type NleRenderResult = { url: string; file: string; coverUrl?: string; verify?: NleVerifyReceipt };
type RenderContext = {
  project: NleProject;
  alpha: boolean;
  motion: RenderMotion;
  epoch: { current: number };
  requests: { current: Set<AbortController> };
  setRendering: (value: boolean) => void;
  setError: (value: string) => void;
  setStatus: (value: string) => void;
  setResult: (value: NleRenderResult | null) => void;
};
export async function requestNleVideo(
  project: NleProject,
  alpha: boolean,
  motion: RenderMotion,
  signal: AbortSignal,
) {
  nleRenderOptions(project, motion.motionSamples, motion.shutterAngle);
  const response = await appFetch("/api/nle/render", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({ project, alpha, ...(motion.motionSamples === 1 ? {} : motion) }),
  });
  const data = await response.json();
  if (!response.ok || typeof data?.url !== "string")
    throw new Error(data?.error ?? t("nleRender.failed"));
  return data as NleRenderResult & { bytes: number };
}
function isNleVerifyReceipt(value: unknown): value is NleVerifyReceipt {
  return Boolean(value) && typeof value === "object" &&
    typeof (value as NleVerifyReceipt).pass === "boolean" &&
    Array.isArray((value as NleVerifyReceipt).checks) &&
    Array.isArray((value as NleVerifyReceipt).remainingChecks);
}

export async function executeNleRender(context: RenderContext) {
  const { project, alpha, motion, epoch, requests, setRendering, setError, setStatus, setResult } =
    context;
  const started = epoch.current,
    controller = new AbortController();
  requests.current.add(controller);
  setRendering(true);
  setError("");
  setResult(null);
  setStatus(t(alpha ? "nleRender.runningAlpha" : "nleRender.running"));
  try {
    const data = await requestNleVideo(
      project,
      alpha,
      motion,
      AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]),
    );
    if (started !== epoch.current) return;
    setResult({
      url: data.url,
      file: data.file,
      ...(typeof data.coverUrl === "string" ? { coverUrl: data.coverUrl } : {}),
      ...(isNleVerifyReceipt(data.verify) ? { verify: data.verify } : {}),
    });
    setStatus(t("nleRender.ready", { size: Math.round(Number(data.bytes) / 1024) }));
  } catch (cause) {
    if (started === epoch.current) {
      setError(cause instanceof Error ? cause.message : t("nleRender.failed"));
      setStatus("");
    }
  } finally {
    requests.current.delete(controller);
    if (started === epoch.current) setRendering(false);
  }
}
