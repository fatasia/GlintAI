import { CloudProviderHttp, CloudProviderError, cloudId, confirmed, modelPath, object, type CloudFetch, type CloudOptions, type ExecutionConfirmation } from "./cloud-provider-http";
export type ReplicateTask = { provider: "replicate"; predictionId: string; state: "pending" | "running" | "success" | "failed" | "cancelled"; output?: unknown };
function task(data: unknown, expectedId?: string): ReplicateTask {
  if (!object(data)) throw new CloudProviderError("replicate", "invalid-response");
  const predictionId = cloudId("replicate", data.id);
  if (expectedId && predictionId !== expectedId) throw new CloudProviderError("replicate", "identity-mismatch");
  const states = { starting: "pending", processing: "running", succeeded: "success", failed: "failed", canceled: "cancelled" } as const;
  if (typeof data.status !== "string" || !Object.hasOwn(states, data.status)) throw new CloudProviderError("replicate", "invalid-status");
  const state = data.error != null ? "failed" : states[data.status as keyof typeof states];
  if (state === "success" && data.output === undefined) throw new CloudProviderError("replicate", "missing-output");
  return { provider: "replicate", predictionId, state, ...(state === "success" ? { output: data.output } : {}) };
}
export class ReplicateClient {
  private readonly http: CloudProviderHttp;
  constructor(apiToken: string, transport?: CloudFetch) { this.http = new CloudProviderHttp("replicate", apiToken, transport); }
  /** Official models use owner/name; pinned community models use a 64-character version digest. */
  async submit(target: { model: string } | { version: string }, input: Record<string, unknown>, options: ExecutionConfirmation): Promise<ReplicateTask> {
    confirmed("replicate", options); if (!object(target) || !object(input)) throw new CloudProviderError("replicate", "invalid-input");
    const keys = Object.keys(target); if (keys.length !== 1 || !["model", "version"].includes(keys[0]!)) throw new CloudProviderError("replicate", "invalid-model");
    let route: string, body: Record<string, unknown>;
    if ("model" in target) { route = `/v1/models/${modelPath("replicate", target.model)}/predictions`; body = { input }; }
    else { if (!/^[a-f0-9]{64}$/.test(target.version)) throw new CloudProviderError("replicate", "invalid-version"); route = "/v1/predictions"; body = { version: target.version, input }; }
    const { data } = await this.http.request(route, "POST", body, options); return task(data);
  }
  async status(predictionId: string, options: CloudOptions = {}): Promise<ReplicateTask> {
    const { data } = await this.http.request(`/v1/predictions/${cloudId("replicate", predictionId)}`, "GET", undefined, options); return task(data, predictionId);
  }
  async result(predictionId: string, options: CloudOptions = {}): Promise<ReplicateTask> {
    const result = await this.status(predictionId, options); if (result.state !== "success") throw new CloudProviderError("replicate", "result-not-successful"); return result;
  }
  /** Returns the vendor's actual state, not a promise that cancellation stopped billing. */
  async cancel(predictionId: string, options: CloudOptions = {}): Promise<ReplicateTask> {
    const { data } = await this.http.request(`/v1/predictions/${cloudId("replicate", predictionId)}/cancel`, "POST", undefined, options); return task(data, predictionId);
  }
}
