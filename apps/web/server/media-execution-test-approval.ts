import { expect } from "vitest";

/** Legal host fixture: declare one CNY price, bind the actual adapter, approve exactly this input. */
export async function approveMediaInput(
  base: string,
  input: Record<string, unknown>,
  options: {
    headers?: Record<string, string>;
    quoteInput?: Record<string, unknown>;
    accountId?: string;
  } = {},
) {
  const headers = { "content-type": "application/json", ...options.headers };
  const comfy = Boolean(input.workflow),
    accountId = options.accountId ?? (comfy ? "comfy" : "gateway");
  const model = {
    id: "host-fixture",
    name: "Host fixture",
    provider: "fixture",
    kind: input.type,
    capabilities: [],
    pricing: { basis: "per-call", amountCny: 0.01 },
    adapter: comfy
      ? { type: "comfyui", workflow: "fixture" }
      : { type: "skills-gateway", model: input.model },
    source: "user",
  };
  const current = await (await fetch(base + "/api/settings/model-registry", { headers })).json();
  const saved = await fetch(base + "/api/settings/model-registry", {
    method: "PUT",
    headers,
    body: JSON.stringify({ registry: { models: [model] }, baseDigest: current.digest }),
  });
  expect(saved.status).toBe(200);
  const post = async (action: string, body: unknown) => {
    const response = await fetch(`${base}/api/media/execution/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  await post("bindings", { id: "fixture-binding", modelId: model.id, accountId });
  const quote = await post("quote", {
    ...(options.quoteInput ?? input),
    bindingId: "fixture-binding",
  });
  await post("approve", {
    quoteId: quote.id,
    requestId: input.requestId,
    capCny: 100,
    confirmed: true,
  });
  return { ...input, bindingId: "fixture-binding", quoteId: quote.id };
}
