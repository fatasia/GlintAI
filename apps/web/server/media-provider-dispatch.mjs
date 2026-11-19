import { FalClient, ReplicateClient } from "@glintai/media";
import { digest } from "./local-agent-common.mjs";
import { cloudRecords } from "./media-cloud-records.mjs";
import { cloudOutputUrl, importCloudOutput } from "./media-cloud-output.mjs";
import { requireExecution, safeId } from "./media-execution-store.mjs";

class CloudMediaAdapter {
  constructor(options) {
    Object.assign(this, options);
    this.records = cloudRecords(options.root);
    this.downloads = new Map();
  }
  async client(record) {
    const account = await this.accounts.resolve(record.accountId);
    requireExecution(
      account.provider === record.protocol && account.fingerprint === record.accountDigest,
      "account-changed",
      409,
    );
    return record.protocol === "fal"
      ? new FalClient(account.token, this.transport)
      : new ReplicateClient(account.token, this.transport);
  }
  async submit(input, bound, signal) {
    requireExecution(safeId(input.requestId), "invalid-request");
    const signature = digest(input);
    const store = this.records.request(input.requestId),
      taskId = `cloud-${input.requestId}`;
    const previous = await store.read();
    if (previous.taskId) {
      requireExecution(previous.signature === signature, "request-conflict", 409);
      return { taskId: previous.taskId, state: previous.state };
    }
    const record = {
      taskId,
      signature,
      type: input.type,
      model: bound.entry.adapter.model,
      protocol: bound.account.provider,
      accountId: bound.account.id,
      accountDigest: bound.account.fingerprint,
      state: "unconfirmed",
      createdAt: new Date().toISOString(),
    };
    await store.update(async (state) => {
      requireExecution(!state.taskId, "request-pending", 409);
      await this.guard(input, record.protocol);
      Object.assign(state, record);
    });
    await this.records.save(taskId, record);
    const client = await this.client(record),
      options = { confirmExecute: true, signal };
    try {
      const params = { ...input.params, prompt: input.prompt };
      const result =
        record.protocol === "fal"
          ? await client.submit(record.model, params, options)
          : await client.submit(
              /^[a-f0-9]{64}$/.test(record.model)
                ? { version: record.model }
                : { model: record.model },
              params,
              options,
            );
      const remoteId = result.requestId ?? result.predictionId;
      await this.records.save(taskId, { ...record, remoteId, state: "pending" });
      return { taskId };
    } catch {
      return { taskId, state: "unconfirmed" };
    }
  }
  async findRequest(id) {
    if (!safeId(id)) return null;
    const record = await this.records.request(id).read();
    return ["fal", "replicate"].includes(record.protocol) ? { taskId: record.taskId } : null;
  }
  async replay(input) {
    requireExecution(safeId(input.requestId), "invalid-request");
    const record = await this.records.request(input.requestId).read();
    if (!["fal", "replicate"].includes(record.protocol)) return null;
    requireExecution(record.signature === digest(input), "request-conflict", 409);
    return { taskId: record.taskId };
  }
  async status(id, signal) {
    let record = await this.records.read(id);
    if (!record.remoteId || record.cancelled) return this.view(record);
    if (!["success", "failed", "cancelled"].includes(record.state)) {
      const client = await this.client(record),
        options = { signal };
      let task =
        record.protocol === "fal"
          ? await client.status(record.model, record.remoteId, options)
          : await client.status(record.remoteId, options);
      let falOutput;
      if (task.state === "completed") {
        const result = await client.result(record.model, record.remoteId, options);
        task = result.task;
        falOutput = result.output;
      }
      if (task.state === "success") {
        const result = record.protocol === "fal" ? falOutput : task.output;
        record.resultUrl = cloudOutputUrl(result, record.type);
      }
      record.state = task.state;
      await this.records.save(id, record);
    }
    if (record.state === "success" && !record.asset) {
      if (!this.downloads.has(id))
        this.downloads.set(
          id,
          importCloudOutput({ ...this, task: record, signal: AbortSignal.timeout(60000) }).finally(
            () => this.downloads.delete(id),
          ),
        );
      Object.assign(record, await this.downloads.get(id));
      await this.records.save(id, record);
    }
    return this.view(record);
  }
  view(record) {
    const state = record.cancelled ? "cancelled" : record.state;
    return {
      taskId: record.taskId,
      type: record.type,
      model: record.model,
      state,
      isFinal: ["success", "failed", "cancelled"].includes(state),
      ...(record.asset ? { assetUrl: `/api/media/assets/${record.asset}` } : {}),
      cancellation: record.cancellation,
      cost: null,
      costUnit: "unknown",
    };
  }
  async cancel(id, signal) {
    const record = await this.records.read(id);
    if (["success", "failed", "cancelled"].includes(record.state)) return this.view(record);
    if (record.remoteId) {
      const client = await this.client(record);
      const result =
        record.protocol === "fal"
          ? await client.cancel(record.model, record.remoteId, { signal })
          : await client.cancel(record.remoteId, { signal });
      record.cancellation = result.cancellation ?? result.state;
      if (result.state === "cancelled" || result.cancellation === "cancelled-queued")
        record.state = "cancelled";
    } else record.cancellation = "submission-unconfirmed";
    await this.records.save(id, record);
    return this.view(record);
  }
}
export function createCloudMediaAdapter(options) {
  return new CloudMediaAdapter(options);
}
