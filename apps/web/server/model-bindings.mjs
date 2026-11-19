import path from "node:path";
import { digest } from "./local-agent-common.mjs";
import { executionStore, recordTable, requireExecution, safeId } from "./media-execution-store.mjs";
const supported = ["fal", "replicate", "skills-gateway", "openai-images", "comfyui"];
function validate(value) {
  recordTable(value, "bindings", 500);
  for (const item of value.bindings)
    requireExecution(
      safeId(item.id) &&
        safeId(item.accountId) &&
        typeof item.modelId === "string" &&
        /^[a-f0-9]{64}$/.test(item.modelDigest) &&
        /^[a-f0-9]{64}$/.test(item.accountDigest),
      "invalid-binding",
    );
  requireExecution(
    new Set(value.bindings.map((item) => item.id)).size === value.bindings.length,
    "duplicate-binding",
  );
  return value;
}
class ModelBindings {
  constructor({ root, registryStore, resolveAccount }) {
    this.registryStore = registryStore;
    this.resolveAccount = resolveAccount;
    this.store = executionStore(
      path.join(root, "model-bindings.json"),
      { version: 1, bindings: [] },
      validate,
    );
  }
  async model(id) {
    const snapshot = await this.registryStore.read();
    const entry = [...snapshot.models, ...snapshot.builtins].find((item) => item.id === id);
    requireExecution(
      entry &&
        supported.includes(entry.adapter.type) &&
        ["image", "video", "audio"].includes(entry.kind),
      "unsupported-adapter",
    );
    return entry;
  }
  async resolve(id) {
    const binding = (await this.store.read()).bindings.find((item) => item.id === id);
    requireExecution(binding, "binding-required", 409);
    const entry = await this.model(binding.modelId),
      account = await this.resolveAccount(binding.accountId);
    requireExecution(
      binding.modelDigest === digest(entry) && binding.accountDigest === account.fingerprint,
      "binding-changed",
      409,
    );
    requireExecution(entry.adapter.type === account.provider, "adapter-account-mismatch");
    return { binding, entry, account, version: digest(binding) };
  }
  async save(input) {
    requireExecution(
      input &&
        Object.keys(input).every((key) => ["id", "modelId", "accountId"].includes(key)) &&
        safeId(input.id) &&
        safeId(input.accountId),
      "invalid-binding",
    );
    const entry = await this.model(input.modelId),
      account = await this.resolveAccount(input.accountId);
    requireExecution(entry.adapter.type === account.provider, "adapter-account-mismatch");
    requireExecution(entry.pricing.basis !== "free-local", "local-price-needs-trusted-policy");
    const binding = {
      id: input.id,
      modelId: entry.id,
      accountId: input.accountId,
      modelDigest: digest(entry),
      accountDigest: account.fingerprint,
    };
    await this.store.update((state) => {
      state.bindings = [...state.bindings.filter((item) => item.id !== binding.id), binding];
    });
    return {
      id: binding.id,
      modelId: entry.id,
      accountId: binding.accountId,
      version: digest(binding),
    };
  }
  async list() {
    return Promise.all(
      (await this.store.read()).bindings.map(async (item) => {
        try {
          const bound = await this.resolve(item.id);
          return {
            id: item.id,
            modelId: item.modelId,
            accountId: item.accountId,
            ready: true,
            entry: bound.entry,
            version: bound.version,
          };
        } catch {
          return {
            id: item.id,
            modelId: item.modelId,
            accountId: item.accountId,
            ready: false,
            reason: "binding-changed",
          };
        }
      }),
    );
  }
}
export function createModelBindings(options) {
  return new ModelBindings(options);
}
