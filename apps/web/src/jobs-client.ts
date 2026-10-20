export interface IdeaJob {
  id: string;
  status: "recovering" | "queued" | "running" | "cancelling" | "done" | "failed" | "cancelled";
  stage?: string;
  log: string[];
  video?: string;
  error?: string;
}
export const terminalJob = (job: IdeaJob | null) => Boolean(job && ["done", "failed", "cancelled"].includes(job.status));
export async function jobRequest(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<any> {
  const timeout = AbortSignal.timeout(20_000);
  const response = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload.error ?? `请求失败 (${response.status})`), {status:response.status});
  return payload;
}
export function parseJob(value: unknown): IdeaJob {
  const job = value as IdeaJob;
  if (!job || typeof job.id !== "string" || !/^idea-[a-z0-9-]+$/.test(job.id) || !["queued", "running", "cancelling", "done", "failed", "cancelled"].includes(job.status) || !Array.isArray(job.log) || job.log.some((line) => typeof line !== "string")) throw new Error("任务响应无效");
  // Media links are derived locally, not accepted from a response body.
  return { ...job, video: job.status === "done" ? `/api/video/${job.id}` : undefined };
}
