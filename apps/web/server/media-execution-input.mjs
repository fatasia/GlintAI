import { quote } from "@glintai/models";
import { digest } from "./local-agent-common.mjs";
import { requireExecution, safeId } from "./media-execution-store.mjs";
const fields = [
  "bindingId",
  "type",
  "model",
  "prompt",
  "params",
  "workflow",
  "inputs",
  "referenceImage",
  "referenceSha256",
  "referenceBinding",
  "canvasReference",
];
export function executionInput(input) {
  requireExecution(
    input && typeof input === "object" && !Array.isArray(input) && safeId(input.bindingId),
    "binding-required",
    409,
  );
  requireExecution(["image", "video", "audio"].includes(input.type), "invalid-type");
  const value = Object.fromEntries(
    fields.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]),
  );
  const json = JSON.stringify(value);
  requireExecution(Buffer.byteLength(json) <= 3 * 1024 * 1024, "input-too-large", 413);
  return { value: JSON.parse(json), inputDigest: digest(value) };
}
export function estimateExecution(bound, input) {
  const { entry } = bound;
  requireExecution(entry.kind === input.type, "model-type-mismatch");
  if (entry.adapter.type !== "comfyui") {
    requireExecution(
      input.model === entry.adapter.model &&
        typeof input.prompt === "string" &&
        input.prompt.trim() &&
        input.prompt.length <= 4000,
      "model-input-mismatch",
    );
    requireExecution(
      input.params && typeof input.params === "object" && !Array.isArray(input.params),
      "invalid-params",
    );
  } else
    requireExecution(input.workflow && typeof input.workflow === "object", "workflow-required");
  requireExecution(entry.pricing.basis !== "free-local", "local-price-needs-trusted-policy");
  requireExecution(entry.pricing.basis !== "unknown", "unknown-cost", 409);
  const usage = { calls: 1 };
  if (entry.pricing.basis === "per-image" && entry.adapter.type === "openai-images") {
    const count = input.params?.n ?? 1;
    requireExecution(
      Number.isSafeInteger(count) && count >= 1 && count <= 10,
      "invalid-image-count",
    );
    usage.images = count;
  } else requireExecution(entry.pricing.basis === "per-call", "unsupported-usage", 409);
  const estimated = quote(entry, usage);
  requireExecution(
    Number.isFinite(estimated.costCny) && estimated.costCny >= 0,
    "unknown-cost",
    409,
  );
  return {
    amount: estimated.costCny,
    units: Math.round(estimated.costCny * 10000),
    unit: "CNY",
    source: "user-declared",
    usage,
  };
}
