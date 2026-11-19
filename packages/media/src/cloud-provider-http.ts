import { fetchPublicAsset } from "@glintai/knowledge";
export type CloudProvider = "fal" | "replicate";
export type CloudFetch = (url: string, init: RequestInit) => Promise<Response>;
export type CloudOptions = { signal?: AbortSignal; timeoutMs?: number };
export type ExecutionConfirmation = CloudOptions & { confirmExecute: boolean };
export class CloudProviderError extends Error {
  constructor(readonly provider: CloudProvider, readonly code: string, readonly status?: number) { super(`${provider}: ${code}${status === undefined ? "" : ` (HTTP ${status})`}`); }
}
export function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
export function cloudId(provider: CloudProvider, value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new CloudProviderError(provider, "invalid-id"); return value;
}
export function confirmed(provider: CloudProvider, options: ExecutionConfirmation) { if (options?.confirmExecute !== true) throw new CloudProviderError(provider, "confirmation-required"); }
export function modelPath(provider: CloudProvider, value: string, maxSegments = 2) {
  if (typeof value !== "string") throw new CloudProviderError(provider, "invalid-model");
  const parts = value.split("/");
  if (parts.length < 2 || parts.length > maxSegments || parts.some(part => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(part))) throw new CloudProviderError(provider, "invalid-model");
  return parts.join("/");
}
const ORIGINS = { fal: "https://queue.fal.run", replicate: "https://api.replicate.com" } as const;
/** Network injection is for host/tests only. Endpoint and authorization scheme are not caller-configurable. */
export class CloudProviderHttp {
  constructor(private readonly provider: CloudProvider, private readonly token: string, private readonly transport: CloudFetch = fetch) {
    if (!token || token.length > 4096 || /[\s\x00-\x1f]/.test(token)) throw new CloudProviderError(provider, "invalid-credential");
  }
  async request(path: string, method: "GET" | "POST" | "PUT", body?: unknown, options: CloudOptions = {}, allowedErrors: number[] = []) {
    const origin = ORIGINS[this.provider], url = new URL(path, origin);
    if (url.origin !== origin || url.search || url.hash || !path.startsWith("/")) throw new CloudProviderError(this.provider, "invalid-api-route");
    const timeout = options.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000) throw new CloudProviderError(this.provider, "invalid-timeout");
    let json: string | undefined;
    try { json = body === undefined ? undefined : JSON.stringify(body); } catch { throw new CloudProviderError(this.provider, "invalid-input"); }
    if (json !== undefined && Buffer.byteLength(json) > 2 * 1024 * 1024) throw new CloudProviderError(this.provider, "request-too-large");
    const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(options.signal ? [options.signal] : [])]);
    try {
      signal.throwIfAborted();
      const response = await this.transport(url.href, { method, body: json, headers: { authorization: `${this.provider === "fal" ? "Key" : "Bearer"} ${this.token}`, "content-type": "application/json" }, redirect: "error", signal });
      if (response.redirected || response.status >= 300 && response.status < 400 || response.url && new URL(response.url).origin !== origin) { await response.body?.cancel(); throw new CloudProviderError(this.provider, "redirect-refused"); }
      if (!response.ok && !allowedErrors.includes(response.status)) { await response.body?.cancel(); throw new CloudProviderError(this.provider, "http-error", response.status); }
      const limit = 4 * 1024 * 1024;
      if (!response.body) throw new CloudProviderError(this.provider, "missing-response");
      if (Number(response.headers.get("content-length")) > limit) { await response.body.cancel(); throw new CloudProviderError(this.provider, "response-too-large"); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) { await reader.cancel(); throw new CloudProviderError(this.provider, "response-too-large"); } chunks.push(value); } }
      finally { reader.releaseLock(); }
      signal.throwIfAborted(); const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return { data, status: response.status };
    } catch (error) {
      if (error instanceof CloudProviderError) throw error;
      throw new CloudProviderError(this.provider, signal.aborted ? "aborted" : "transport-or-response-error");
    }
  }
}
/** The API token is not in scope here. Existing HTTPS/DNS-pinning/10 MiB boundary is reused. */
export async function downloadCloudOutput(url: string, signal = AbortSignal.timeout(60000)) {
  return fetchPublicAsset(url, signal, 0, true);
}
