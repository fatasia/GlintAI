import { appFetch as fetch } from "./app-url";
import type { DesignDocument } from "./design-artifacts";
import { brandExportDocument, type BrandTheme } from "./design-brand";
export type DesignExportFormat = "html" | "png" | "pdf" | "pptx" | "zip";
export type DesignExportResult = { file: string; bytes: number; path: string; warnings: string[]; editableElements?: number; url: string };
export async function exportDesignDocument(document: DesignDocument, format: DesignExportFormat, signal?: AbortSignal, brand: BrandTheme | null = null): Promise<DesignExportResult> {
  const exported = brandExportDocument(document, brand);
  const timeout = AbortSignal.timeout(120_000);
  const response = await fetch("/api/design/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document: exported, format }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  let result: unknown;
  try { result = await response.json(); } catch { throw new Error(`设计导出响应无效 (${response.status})，请稍后重试。`); }
  const payload = result as Partial<DesignExportResult> & { error?: string };
  if (!response.ok) throw Object.assign(new Error(typeof payload?.error === "string" ? payload.error : `设计导出失败 (${response.status})。`), { status: response.status });
  if (!payload || typeof payload.file !== "string" || !/^design-[a-f\d-]+\.(html|png|pdf|pptx|zip)$/.test(payload.file) || !Number.isFinite(payload.bytes) || payload.bytes! <= 0 || !Array.isArray(payload.warnings) || payload.warnings.some(w => typeof w !== "string") || (payload.editableElements !== undefined && (!Number.isInteger(payload.editableElements) || payload.editableElements < 0))) throw new Error("设计导出结果无效，请重新导出。");
  // Never trust arbitrary URLs or filesystem paths as a download destination.
  return { file: payload.file, bytes: payload.bytes!, path: typeof payload.path === "string" ? payload.path : "", warnings: payload.warnings, ...(payload.editableElements === undefined ? {} : { editableElements: payload.editableElements }), url: `/api/design/exports/${encodeURIComponent(payload.file)}` };
}
