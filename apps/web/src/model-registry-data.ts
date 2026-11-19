import { builtinRegistry, parseRegistryJson, type ModelEntry } from "@glintai/models";

export const REGISTRY_BYTES = 512 * 1024;
export class RegistryImportError extends Error {
  constructor(readonly code: "invalid" | "too-large" | "secret" | "reserved") {
    super(code);
  }
}
const fields = [
  "id",
  "name",
  "provider",
  "kind",
  "capabilities",
  "pricing",
  "limits",
  "adapter",
  "source",
  "notes",
];
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new RegistryImportError("invalid");
  return value as Record<string, unknown>;
}
function rejectSecrets(value: unknown, depth = 0): void {
  if (depth > 8) throw new RegistryImportError("invalid");
  if (
    typeof value === "string" &&
    /(?:\bsk-[A-Za-z0-9_-]{12,}|\bBearer\s+\S+|BEGIN[ A-Z]*PRIVATE KEY|(?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]|https?:\/\/[^\s/]+@)/i.test(
      value,
    )
  )
    throw new RegistryImportError("secret");
  if (value && typeof value === "object")
    for (const child of Object.values(value)) rejectSecrets(child, depth + 1);
}
function checkEntry(value: unknown): void {
  const entry = object(value, fields);
  if (entry.source !== undefined && entry.source !== "user")
    throw new RegistryImportError("reserved");
  if (builtinRegistry().entries.some((model) => model.id === entry.id))
    throw new RegistryImportError("reserved");
  object(entry.adapter, ["type", "model", "workflow"]);
  const pricing = object(entry.pricing, ["basis", "amountCny"]);
  if (["unknown", "free-local"].includes(String(pricing.basis)) && "amountCny" in pricing)
    throw new RegistryImportError("invalid");
  if (entry.limits !== undefined)
    object(entry.limits, ["maxDurationSec", "maxReferenceImages", "aspects", "resolutions"]);
}
/** Import validation is stricter about unknown input keys; the existing registry remains the contract. */
export function parseRegistryImport(text: string): ModelEntry[] {
  if (new TextEncoder().encode(text).byteLength > REGISTRY_BYTES)
    throw new RegistryImportError("too-large");
  try {
    const data = object(JSON.parse(text), ["models"]);
    if (!Array.isArray(data.models)) throw new RegistryImportError("invalid");
    if (data.models.length > 500) throw new RegistryImportError("too-large");
    rejectSecrets(data);
    data.models.forEach(checkEntry);
    return [...parseRegistryJson(text).entries];
  } catch (error) {
    if (error instanceof RegistryImportError) throw error;
    throw new RegistryImportError("invalid");
  }
}
export interface RegistrySnapshot {
  models: ModelEntry[];
  builtins: ModelEntry[];
  digest: string;
}

export function registryTemplate(): ModelEntry[] {
  return parseRegistryImport(
    JSON.stringify({
      models: [
        {
          id: "example-image",
          name: "Example image",
          provider: "example",
          kind: "image",
          capabilities: [],
          pricing: { basis: "unknown" },
          adapter: { type: "skills-gateway", model: "replace-with-provider-model-id" },
        },
      ],
    }),
  );
}
