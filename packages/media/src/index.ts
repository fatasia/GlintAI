import { setTimeout as delay } from "node:timers/promises";
import { fetchPublicAsset } from "@glintai/knowledge";
export interface MediaGatewayConfig { baseUrl: string; apiKey: string; pollIntervalMs?: number }
export interface MediaTask { task_id: string | number; state: "pending" | "running" | "success" | "failed"; is_final: boolean; result_url?: string; result_type?: string; cost?: number }
export class MediaGatewayClient {
  private readonly base: string;
  constructor(private readonly config: MediaGatewayConfig) {
    const url = new URL(config.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Media gateway requires a credential-free HTTPS base URL");
    this.base = url.href.replace(/\/+$/, "").replace(/\/v1$/, "");
  }
  private async json(route: string, signal: AbortSignal, body?: unknown) {
    const response = await fetch(`${this.base}${route}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal, redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Media gateway returned HTTP ${response.status}`); }
    if (!response.body) throw new Error("Empty media gateway response");
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("Media metadata exceeds 2 MiB"); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  async models(type: "audio" | "image" | "video", signal = AbortSignal.timeout(20000)) {
    const data = await this.json(`/v1/skills/models?type=${type}`, signal);
    if (!Array.isArray(data.models)) throw new Error("Invalid media model catalog");
    return data.models.filter((item: any) => typeof item.name === "string" && item.available_for_this_key !== false).map((item: any) => ({ id: item.name as string, name: String(item.display_name ?? item.name), type }));
  }
  async voices(model: string, signal = AbortSignal.timeout(20000)) { return this.json(`/v1/skills/voices?model=${encodeURIComponent(model)}`, signal); }
  async submit(model: string, prompt: string, params: Record<string, unknown> = {}, signal = AbortSignal.timeout(30000)) {
    if (!model.trim() || model.length > 160 || !prompt.trim() || prompt.length > 10000 || JSON.stringify(params).length > 40 * 1024 * 1024) throw new Error("Invalid media request");
    const data = await this.json("/v1/media/generate", signal, { model, prompt, params });
    const id = data.data?.task_id ?? data.task_id;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(String(id ?? ""))) throw new Error("Media submission did not return a task ID; do not resubmit automatically");
    return String(id);
  }
  async status(taskId: string, signal = AbortSignal.timeout(20000)): Promise<MediaTask> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) throw new Error("Invalid media task ID");
    const raw = await this.json(`/v1/media/status?task_id=${encodeURIComponent(taskId)}`, signal);
    const data = raw.data?.state ? raw.data : raw;
    if (!["pending", "running", "success", "failed"].includes(data.state) || typeof data.is_final !== "boolean") throw new Error("Invalid media task status");
    return data;
  }
  async wait(taskId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<MediaTask> {
    const deadline = AbortSignal.timeout(options.timeoutMs ?? 600000), signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    while (true) {
      signal.throwIfAborted();
      const task = await this.status(taskId, signal);
      if (task.is_final) {
        if (task.state !== "success" || !task.result_url) throw new Error(`Media task ${taskId} failed; inspect its status before retrying`);
        return task;
      }
      await delay(Math.max(5000, this.config.pollIntervalMs ?? 5000), undefined, { signal });
    }
  }
}
/** Validated public HTTPS fetch, DNS-pinned, 10 MiB limit; never forwards API credentials. */
export async function downloadMediaResult(task: MediaTask, signal = AbortSignal.timeout(60000), options: { publicDns?: boolean } = {}) {
  if (!task.is_final || task.state !== "success" || !task.result_url) throw new Error("Media task is not complete");
  // Opt-in for TUN/Fake-IP environments. All resolved addresses are still checked
  // and pinned by fetchPublicAsset, including redirects. No private-IP bypass.
  const resolver = options.publicDns ? async (hostname: string, signal: AbortSignal) => {
    const response = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A&edns_client_subnet=0.0.0.0%2F0`, { signal, redirect: "error" });
    if (!response.ok) throw new Error("Public DNS lookup failed");
    const data = await response.json();
    return (data.Answer ?? []).filter((answer: any) => answer.type === 1 && typeof answer.data === "string").map((answer: any) => ({ address: answer.data as string, family: 4 }));
  } : undefined;
  return fetchPublicAsset(task.result_url, signal, 0, true, resolver);
}
