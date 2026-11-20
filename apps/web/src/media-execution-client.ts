import { appFetch } from "./app-url";
import type { ModelEntry } from "@glintai/models";

export type ExecutionConfig = {
  accounts: { id: string; provider: string; configured: boolean }[];
  bindings: {
    id: string;
    modelId: string;
    accountId: string;
    ready: boolean;
    reason?: string;
    entry?: ModelEntry;
  }[];
  models: { models: ModelEntry[]; builtins: ModelEntry[] };
};
export type ExecutionQuote = {
  id: string;
  amount: number;
  unit: string;
  expiresAt: number;
  inputDigest: string;
};
export type ExecutionTask = {
  taskId: string;
  state?: string;
  isFinal?: boolean;
  assetUrl?: string;
  cancellation?: string;
  outputs?: { index: number; name: string }[];
};
export function executionPayload(
  bindingId: string,
  entry: ModelEntry | undefined,
  prompt: string,
  params: unknown,
) {
  if (!params || typeof params !== "object" || Array.isArray(params))
    throw new Error("invalid-params");
  if (entry?.adapter.type === "comfyui") {
    const workflow = params as { workflow?: unknown; inputs?: unknown };
    return {
      bindingId,
      type: entry.kind,
      workflow: workflow.workflow,
      inputs: workflow.inputs ?? [],
    };
  }
  return { bindingId, type: entry?.kind, model: entry?.adapter.model, prompt, params };
}
export async function executionRequest<T>(route: string, body?: unknown): Promise<T> {
  const response = await appFetch(
    `/api/media/execution/${route}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.code ?? data.error ?? `HTTP ${response.status}`);
  return data as T;
}
/** GET /bindings answers with the bare list; older drafts assumed an envelope that never existed. */
export async function executionBindings(): Promise<ExecutionConfig["bindings"]> {
  const value = await executionRequest<ExecutionConfig["bindings"] | { bindings?: ExecutionConfig["bindings"] }>("bindings");
  return Array.isArray(value) ? value : value.bindings ?? [];
}
export function rememberExecution(key: string, value: { requestId: string; taskId?: string }) {
  try {
    localStorage.setItem(`${key}.bound`, JSON.stringify(value));
  } catch {
    /* IDs remain visible when storage is unavailable. */
  }
}
export function readExecution(key: string): { requestId: string; taskId?: string } | null {
  try {
    const value = JSON.parse(localStorage.getItem(`${key}.bound`) ?? "null");
    return /^[A-Za-z0-9_-]{1,64}$/.test(value?.requestId ?? "") ? value : null;
  } catch {
    return null;
  }
}
