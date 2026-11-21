import { useEffect, useState } from "react";
import { previewContainerPlan, type PlanPreviewIntent, type PlanPreviewReply } from "./container-workspace-client";
import { t } from "./ui/i18n";

/**
 * K-03 影响预览条目：在“应用/保存/导出”类动作前，按需展开展示只读预测
 * （影响对象数、将重建节点、预计耗时、费用类型）；预览本身不执行、不落盘，
 * 展开才发一次预测请求，不随工作台挂载自动请求。
 * `actualMs` 来自执行回执（NLE 导出 elapsedMs）；回执到达时自动展开并显示“预测 vs 实际”。
 */
export function ContainerPlanPreview({ projectId, intent, actualMs }: {
  projectId?: string;
  intent?: PlanPreviewIntent;
  /** Actual wall-clock ms from the execution receipt; absent until an export finished. */
  actualMs?: number | null;
}) {
  const [open, setOpen] = useState(false), [preview, setPreview] = useState<PlanPreviewReply | null>(null), [error, setError] = useState("");
  const intentKey = JSON.stringify(intent ?? {});
  useEffect(() => {
    // A finished execution carries its real wall time: surface the comparison without a click.
    if (typeof actualMs === "number" && actualMs > 0) setOpen(true);
  }, [actualMs]);
  useEffect(() => {
    if (!projectId || !open) return;
    const controller = new AbortController();
    setError("");
    previewContainerPlan(projectId, intent, controller.signal)
      .then(value => { if (!controller.signal.aborted) setPreview(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("planPreview.unavailable")); });
    return () => controller.abort();
    // intent is deliberately serialized (intentKey): list identities stay stable across renders.
  }, [projectId, intentKey, open]);
  if (!projectId) return null;
  const impact = preview?.impact;
  const seconds = impact ? Math.max(1, Math.round(impact.estimatedMs / 1000)) : 0;
  const actual = typeof actualMs === "number" && actualMs > 0 ? Math.max(1, Math.round(actualMs / 1000)) : null;
  const timeline = preview?.timelineExports[0];
  return (
    <details
      className="plan-preview"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{t("planPreview.title")}</summary>
      {error && <p className="ws-note" role="note">{t("planPreview.unavailable")}：{error}</p>}
      {impact && (
        <ul className="plan-preview-list">
          <li>{t("planPreview.objects", { count: impact.affectedObjects.length })}</li>
          <li>{t("planPreview.nodes", { predicted: impact.predicted.length, reused: impact.reusedCount })}</li>
          <li>{impact.totalNodes > 0 ? t("planPreview.time", { seconds }) : t("planPreview.timeUnknown")}</li>
          <li>{impact.costType === "quote-required"
            ? t("planPreview.costQuote", { count: impact.quoteRequired.length })
            : t("planPreview.costLocal")}</li>
          {timeline && <li>{t("planPreview.timeline", { clips: timeline.clips, seconds: Math.max(1, Math.round(timeline.durationMs / 1000)) })}</li>}
          {actual !== null && timeline
            ? <li>{t("planPreview.actualTimeline", { clips: timeline.clips, seconds: Math.max(1, Math.round(timeline.durationMs / 1000)), actual })}</li>
            : actual !== null && impact.totalNodes > 0
                ? <li>{t("planPreview.actual", { estimated: seconds, actual })}</li>
                : null}
        </ul>
      )}
    </details>
  );
}
