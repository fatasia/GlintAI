import type { SceneScriptProject } from "@glintai/scenescript";
import { applicationUrl } from "./app-url";
import { parseEditorProject } from "./editor-model";
import type { ComposedWork } from "./ProjectComposer";
import { t } from "./ui/i18n";

export interface VideoSelection { url: string; origin: "generated" | "footage"; source?: string }

export function managedVideoName(url: string): string {
  const match = /^\/(?:api\/media\/assets|assets)\/([a-zA-Z0-9_-]{1,100}\.mp4)$/.exec(url);
  if (!match) throw new Error(t("creation.invalidVideo"));
  return match[1]!;
}

export function createMediaWork(asset: VideoSelection, durationMs: number, aspect: SceneScriptProject["aspect"], title: string, id: string): ComposedWork {
  const name = managedVideoName(asset.url);
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 3_600_000) throw new Error(t("creation.durationFailed"));
  const text = title.trim() || t("creation.untitled");
  const project = parseEditorProject({ schemaVersion: 1, id, title: text, aspect, knowledgeSources: [], theme: "glint-dark",
    scenes: [{ id: "shot-1", kind: "video", src: `assets/${name}`, narration: { text, durationMs }, provenance: { origin: asset.origin, ...(asset.source ? { source: asset.source } : {}) } }] });
  return { project, source: text, generatedSource: false };
}

/** Read the actual source, never invent a five-second duration for an unknown clip. */
export function readVideoDuration(url: string, signal: AbortSignal): Promise<number> {
  managedVideoName(url);
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const finish = (error?: Error) => {
      clearTimeout(timer); signal.removeEventListener("abort", aborted);
      video.onloadedmetadata = null; video.onerror = null;
      const ms = Math.round(video.duration * 1000);
      video.removeAttribute("src"); video.load();
      if (error || !Number.isSafeInteger(ms) || ms < 1 || ms > 3_600_000) reject(error ?? new Error(t("creation.durationFailed")));
      else resolve(ms);
    };
    const aborted = () => finish(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => finish(new Error(t("creation.durationFailed"))), 10_000);
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    video.preload = "metadata"; video.onloadedmetadata = () => finish(); video.onerror = () => finish(new Error(t("creation.durationFailed")));
    video.src = applicationUrl(url);
  });
}
