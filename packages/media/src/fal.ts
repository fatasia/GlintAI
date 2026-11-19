import { CloudProviderHttp, CloudProviderError, cloudId, confirmed, modelPath, object, type CloudFetch, type CloudOptions, type ExecutionConfirmation } from "./cloud-provider-http";
export type FalTask = { provider: "fal"; model: string; requestId: string; state: "pending" | "running" | "completed" | "success" | "failed" };
export class FalClient {
  private readonly http: CloudProviderHttp;
  constructor(apiKey: string, transport?: CloudFetch) { this.http = new CloudProviderHttp("fal", apiKey, transport); }
  private route(model: string, requestId: string) { return `/${modelPath("fal", model, 6).split("/").slice(0, 2).join("/")}/requests/${cloudId("fal", requestId)}`; }
  /** Single POST; persist model + requestId. An uncertain response must not trigger automatic resubmission. */
  async submit(model: string, input: Record<string, unknown>, options: ExecutionConfirmation): Promise<{ provider: "fal"; model: string; requestId: string }> {
    confirmed("fal", options); modelPath("fal", model, 6); if (!object(input)) throw new CloudProviderError("fal", "invalid-input");
    const { data } = await this.http.request(`/${model}`, "POST", input, options);
    if (!object(data) || data.error) throw new CloudProviderError("fal", "submission-unconfirmed");
    return { provider: "fal", model, requestId: cloudId("fal", data.request_id) };
  }
  async status(model: string, requestId: string, options: CloudOptions = {}): Promise<FalTask> {
    const { data } = await this.http.request(this.route(model, requestId) + "/status", "GET", undefined, options);
    if (!object(data) || data.request_id !== requestId || !["IN_QUEUE", "IN_PROGRESS", "COMPLETED"].includes(String(data.status))) throw new CloudProviderError("fal", "invalid-status");
    const state = data.status === "IN_QUEUE" ? "pending" : data.status === "IN_PROGRESS" ? "running" : data.error != null || data.error_type != null ? "failed" : "completed";
    return { provider: "fal", model, requestId, state };
  }
  async result(model: string, requestId: string, options: CloudOptions = {}): Promise<{ task: FalTask; output: Record<string, unknown> }> {
    const task = await this.status(model, requestId, options);
    if (task.state !== "completed") throw new CloudProviderError("fal", "result-not-successful");
    const { data } = await this.http.request(this.route(model, requestId), "GET", undefined, options);
    if (!object(data) || data.error != null) throw new CloudProviderError("fal", "invalid-result");
    return { task: { ...task, state: "success" }, output: data };
  }
  async cancel(model: string, requestId: string, options: CloudOptions = {}): Promise<{ provider: "fal"; requestId: string; cancellation: "cancelled-queued" | "requested" | "already-completed" | "not-found" }> {
    const { data, status } = await this.http.request(this.route(model, requestId) + "/cancel", "PUT", undefined, options, [400, 404]);
    const outcomes = { "200:OK": "cancelled-queued", "202:CANCELLATION_REQUESTED": "requested", "400:ALREADY_COMPLETED": "already-completed", "404:NOT_FOUND": "not-found" } as const;
    const key = `${status}:${object(data) ? data.status : ""}`;
    if (!Object.hasOwn(outcomes, key)) throw new CloudProviderError("fal", "invalid-cancellation");
    return { provider: "fal", requestId, cancellation: outcomes[key as keyof typeof outcomes] };
  }
}
