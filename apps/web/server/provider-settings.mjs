import path from "node:path";
import { digest } from "./local-agent-common.mjs";
import { executionStore, recordTable, requireExecution, safeId } from "./media-execution-store.mjs";
const providers = ["fal", "replicate"];
function account(value) {
  requireExecution(
    value && Object.keys(value).every((key) => ["id", "provider", "token"].includes(key)),
    "invalid-account",
  );
  requireExecution(
    safeId(value.id) &&
      !["gateway", "comfy"].includes(value.id) &&
      providers.includes(value.provider),
    "invalid-account",
  );
  requireExecution(
    typeof value.token === "string" &&
      value.token.length >= 8 &&
      value.token.length <= 4096 &&
      ![...value.token].some((character) => character.charCodeAt(0) <= 32),
    "invalid-credential",
  );
  return value;
}
function validate(value) {
  recordTable(value, "accounts", 32);
  value.accounts.forEach(account);
  requireExecution(
    new Set(value.accounts.map((item) => item.id)).size === value.accounts.length,
    "duplicate-account",
  );
  return value;
}
export function createProviderSettings(root) {
  const store = executionStore(
    path.join(root, "provider-credentials.json"),
    { version: 1, accounts: [] },
    validate,
    256 * 1024,
  );
  return {
    async list() {
      return (await store.read()).accounts.map(({ id, provider }) => ({
        id,
        provider,
        configured: true,
      }));
    },
    async save(input) {
      const next = account(structuredClone(input));
      await store.update((state) => {
        const existing = state.accounts.find((item) => item.id === next.id);
        requireExecution(
          !existing || existing.provider === next.provider,
          "account-provider-conflict",
          409,
        );
        state.accounts = [...state.accounts.filter((item) => item.id !== next.id), next];
      });
      return { id: next.id, provider: next.provider, configured: true };
    },
    async resolve(id) {
      const entry = (await store.read()).accounts.find((item) => item.id === id);
      requireExecution(entry, "account-missing", 409);
      return { ...entry, fingerprint: digest(entry) };
    },
  };
}
