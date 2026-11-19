import { createLibraryWriter, probeIngest } from "./media-library.mjs";
import { digest } from "./local-agent-common.mjs";
import { createProviderSettings } from "./provider-settings.mjs";
import { createModelBindings } from "./model-bindings.mjs";
import { createMediaQuoteStore } from "./media-quote-store.mjs";
import { createCloudMediaAdapter } from "./media-provider-dispatch.mjs";
import { requireExecution } from "./media-execution-store.mjs";
import { installExecutionGuard } from "./media-execution-guard.mjs";

/** Host-owned policy: requests, model data and environment flags cannot replace it. */
class MediaExecution {
  constructor(options) {
    Object.assign(this, options);
    const { root, registryStore, jobs, transport, download, now } = options;
    this.accounts = createProviderSettings(root);
    this.bindings = createModelBindings({
      root,
      registryStore,
      resolveAccount: (id) => this.resolveAccount(id),
    });
    this.quotes = createMediaQuoteStore({ root, bindings: this.bindings, now });
    const guard = (input, adapter) => this.quotes.consume(input, adapter);
    installExecutionGuard(jobs, guard);
    this.cloud = createCloudMediaAdapter({
      root,
      accounts: this.accounts,
      guard,
      writer: createLibraryWriter(root),
      asset: jobs.asset,
      probe: probeIngest,
      transport,
      download,
    });
    jobs.setCloudAdapter?.(this.cloud);
  }
  async resolveAccount(id) {
    if (id === "gateway") {
      const config = this.mediaSettings.env();
      requireExecution(config.baseUrl && config.apiKey, "account-missing", 409);
      return {
        id,
        provider: config.protocol === "openai-images" ? "openai-images" : "skills-gateway",
        fingerprint: digest(config),
      };
    }
    if (id === "comfy") {
      const config = this.jobs.comfyui?.config() ?? { configured: false };
      requireExecution(config.configured, "account-missing", 409);
      return { id, provider: "comfyui", fingerprint: digest(config) };
    }
    return this.accounts.resolve(id);
  }
  async config() {
    const gateway = this.mediaSettings.read(),
      comfy = this.jobs.comfyui?.config() ?? { configured: false };
    return {
      accounts: [
        ...(await this.accounts.list()),
        {
          id: "gateway",
          provider: gateway.protocol === "openai-images" ? "openai-images" : "skills-gateway",
          configured: gateway.configured,
        },
        { id: "comfy", provider: "comfyui", configured: comfy.configured },
      ],
      bindings: await this.bindings.list(),
      models: await this.registryStore.read(),
      budgetMeaning: "local-estimate-reservation-not-provider-cap",
    };
  }
  async submit(input, signal) {
    const replay = await this.cloud.replay(input);
    if (replay) return replay;
    if (this.jobs.findRequest(input.requestId))
      return input.workflow
        ? this.jobs.comfyui.submit({ ...input, confirmed: true }, signal)
        : this.jobs.submit(input, signal);
    const bound = await this.bindings.resolve(input.bindingId);
    const provider = bound.entry.adapter.type;
    if (["fal", "replicate"].includes(provider)) return this.cloud.submit(input, bound, signal);
    if (provider === "comfyui")
      return this.jobs.comfyui.submit({ ...input, confirmed: true }, signal);
    return this.jobs.submit(input, signal);
  }
  async status(id, signal) {
    return id.startsWith("cloud-") ? this.cloud.status(id, signal) : this.jobs.status(id, signal);
  }
  async request(id) {
    return (await this.cloud.findRequest(id)) ?? this.jobs.findRequest(id);
  }
  async cancel(id, signal) {
    return id.startsWith("cloud-") ? this.cloud.cancel(id, signal) : this.jobs.cancel(id, signal);
  }
  async import(id, index, signal) {
    return this.jobs.comfyui.importOutput(id, index, signal);
  }
}
export function createMediaExecution(options) {
  return new MediaExecution(options);
}
