import { useEffect, useRef, useState, type CSSProperties } from "react";

type Report = {
  pass: boolean;
  sha256: string | null;
  bytes: number;
  duration?: number;
  checks: { name: string; pass: boolean }[];
};
type State =
  | { kind: "idle" | "pending" | "cancelled" }
  | { kind: "error"; message: string }
  | { kind: "result"; report: Report };
type Request = { controller: AbortController; timer: ReturnType<typeof setTimeout> };
const TIMEOUT_MS = 185_000;
const buttonStyle: CSSProperties = {
  font: "inherit", color: "inherit", background: "transparent", border: "1px solid currentColor",
  borderRadius: 6, padding: "8px 12px", cursor: "pointer",
};

function isReport(value: unknown): value is Report {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.pass === "boolean"
    && (item.sha256 === null || (typeof item.sha256 === "string" && /^[a-f\d]{64}$/i.test(item.sha256)))
    && typeof item.bytes === "number" && Number.isSafeInteger(item.bytes) && item.bytes >= 0
    && (item.duration === undefined || (typeof item.duration === "number" && Number.isFinite(item.duration) && item.duration >= 0))
    && Array.isArray(item.checks) && item.checks.every(check => check && typeof check === "object"
      && typeof check.name === "string" && check.name.trim().length > 0 && typeof check.pass === "boolean");
}

function checkLabel(name: string): string {
  const labels: Record<string, string> = {
    input: "输入文件可读性", sha256: "文件摘要计算", probe: "媒体信息探测", video: "视频轨道",
    duration: "有效时长", "audio-policy": "音频轨道策略", decode: "完整解码",
    "file-unchanged": "检查期间文件未变化", cancelled: "检查已取消", timeout: "检查超时", arguments: "检查参数",
  };
  if (Object.prototype.hasOwnProperty.call(labels, name)) return labels[name]!;
  const stream = /^(loudness|true-peak|audio-measurement):(\d+)$/.exec(name);
  if (stream) {
    const label = stream[1] === "loudness" ? "响度" : stream[1] === "true-peak" ? "真峰值" : "音频测量";
    return `${label}（音轨索引 ${stream[2]}）`;
  }
  return `其他技术检查（${name}）`;
}

/** A new job owns a fresh lifecycle, including state and the in-flight guard. */
export function DeliveryCheck({ jobId }: { jobId: string }) {
  return <JobDeliveryCheck key={jobId} jobId={jobId} />;
}

function JobDeliveryCheck({ jobId }: { jobId: string }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const active = useRef<Request | null>(null);
  useEffect(() => () => {
    const request = active.current;
    active.current = null;
    if (request) { clearTimeout(request.timer); request.controller.abort(); }
  }, []);

  const stop = () => {
    const request = active.current;
    if (!request) return;
    active.current = null;
    clearTimeout(request.timer);
    request.controller.abort();
    setState({ kind: "cancelled" });
  };
  const run = async () => {
    if (active.current) return;
    const controller = new AbortController();
    const request: Request = {
      controller,
      timer: setTimeout(() => {
        if (active.current !== request) return;
        active.current = null;
        controller.abort();
        setState({ kind: "error", message: "检查超时，已停止等待。可手动重试。" });
      }, TIMEOUT_MS),
    };
    active.current = request;
    setState({ kind: "pending" });
    try {
      const response = await fetch(`/api/delivery-check/${encodeURIComponent(jobId)}`, { method: "POST", signal: controller.signal });
      if (active.current !== request || controller.signal.aborted) return;
      if (!response.ok) {
        setState({ kind: "error", message: response.status === 409
          ? "已有文件检查正在进行（HTTP 409）。请等待完成后手动重试。"
          : `检查请求失败（HTTP ${response.status}）。请稍后手动重试。` });
        return;
      }
      let value: unknown;
      try { value = await response.json(); }
      catch {
        if (active.current === request && !controller.signal.aborted) setState({ kind: "error", message: "检查服务返回了无效 JSON，无法确认技术结果。可手动重试。" });
        return;
      }
      if (active.current !== request || controller.signal.aborted) return;
      if (!isReport(value)) {
        setState({ kind: "error", message: "检查结果格式无效，无法确认技术结果。可手动重试。" });
        return;
      }
      setState({ kind: "result", report: value });
    } catch {
      if (active.current === request && !controller.signal.aborted) setState({ kind: "error", message: "无法连接检查服务，未获得技术结果。请检查连接后手动重试。" });
    } finally {
      clearTimeout(request.timer);
      if (active.current === request) active.current = null;
    }
  };
  const pending = state.kind === "pending";
  const report = state.kind === "result" ? state.report : null;
  return <section aria-label="最终文件技术检查" style={{ color: "inherit", font: "inherit", border: "1px solid currentColor", borderRadius: 8, padding: 16, display: "grid", gap: 12, minWidth: 0 }}>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <button type="button" disabled={pending} title={pending ? "正在检查，请等待或取消检查" : undefined}
        style={{ ...buttonStyle, opacity: pending ? 0.5 : 1, cursor: pending ? "not-allowed" : "pointer" }} onClick={() => void run()}>检查最终文件</button>
      {pending && <button type="button" style={buttonStyle} onClick={stop}>取消检查</button>}
    </div>
    <p role={state.kind === "error" ? "alert" : "status"} aria-live="polite" aria-atomic="true" style={{ margin: 0 }}>
      {state.kind === "idle" && "仅检查当前任务的最终文件；不会自动开始或重试。"}
      {pending && "正在检查最终文件…最多等待 185 秒，可取消检查。"}
      {state.kind === "cancelled" && "已取消检查，未确认技术结果。可手动重试。"}
      {state.kind === "error" && state.message}
      {report && <strong>{report.pass ? "技术检查通过" : "技术检查未通过"}</strong>}
    </p>
    {report && <div style={{ display: "grid", gap: 8, overflowWrap: "anywhere", fontVariantNumeric: "tabular-nums" }}>
      <ul style={{ margin: 0, paddingInlineStart: 24 }}>{report.checks.map((check, index) => <li key={`${index}:${check.name}`}>
        {check.pass ? "✓ 通过" : "✕ 未通过"} · {checkLabel(check.name)}
      </li>)}</ul>
      <span>文件大小：{report.bytes} 字节</span>
      {report.duration !== undefined && <span>时长：{report.duration.toFixed(2)} 秒</span>}
      {report.sha256 !== null && <span>SHA-256：<code>{report.sha256}</code></span>}
    </div>}
    <small>仅为技术检查，不检查画面色彩、人物身份或口型同步；技术通过不代表视觉质量已审核。音频为可选项：无音轨不一定是失败，本结果也不代表已完成听评。</small>
  </section>;
}
