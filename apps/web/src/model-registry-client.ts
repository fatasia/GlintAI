import { appFetch } from "./app-url";
import { builtinRegistry } from "@glintai/models";
import { parseRegistryImport, type RegistrySnapshot } from "./model-registry-data";
export class RegistryRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export async function registryRequest(
  signal: AbortSignal,
  body?: unknown,
): Promise<RegistrySnapshot> {
  const response = await appFetch("/api/settings/model-registry", {
    signal,
    ...(body === undefined
      ? {}
      : {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new RegistryRequestError(typeof data?.code === "string" ? data.code : "storage");
  if (!data || typeof data.digest !== "string" || !/^[a-f0-9]{64}$/.test(data.digest))
    throw new RegistryRequestError("storage");
  return {
    digest: data.digest,
    models: parseRegistryImport(JSON.stringify({ models: data.models })),
    builtins: [...builtinRegistry().entries],
  };
}
export function downloadRegistry(models: RegistrySnapshot["models"]) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify({ models }, null, 2) + "\n"], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "model-registry.json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
