import { expect, it } from "vitest";
import { parseRegistryImport, REGISTRY_BYTES } from "./model-registry-data";
const model = {
  id: "fixture-image",
  name: "Image fixture",
  provider: "example",
  kind: "image",
  capabilities: ["reference-image"],
  pricing: { basis: "unknown" },
  adapter: { type: "skills-gateway", model: "original-model-id" },
};
it("roundtrips the existing registry contract without guessing prices or model identifiers", () => {
  const input = JSON.stringify({ models: [model] });
  const [entry] = parseRegistryImport(input);
  expect(entry).toMatchObject({ ...model, source: "user", limits: {} });
  expect(parseRegistryImport(JSON.stringify({ models: [entry] }))).toEqual([entry]);
  expect(input).toBe(JSON.stringify({ models: [model] }));
});
it("rejects unknown fields at every level instead of stripping dangerous data", () => {
  for (const input of [
    { models: [model], endpoint: "https://example.test" },
    { models: [{ ...model, apiKey: "fixture" }] },
    { models: [{ ...model, adapter: { ...model.adapter, endpoint: "https://example.test" } }] },
    { models: [{ ...model, limits: { command: "fixture" } }] },
    { models: [{ ...model, pricing: { basis: "unknown", amountCny: 0 } }] },
  ])
    expect(() => parseRegistryImport(JSON.stringify(input))).toThrow("invalid");
});
it("rejects obvious credentials without echoing them and protects builtins", () => {
  const privateValue = "Bearer fixture-private-value";
  expect(() =>
    parseRegistryImport(JSON.stringify({ models: [{ ...model, notes: privateValue }] })),
  ).toThrow("secret");
  for (const item of [
    { ...model, source: "builtin" },
    { ...model, id: "windows-sapi" },
  ])
    expect(() => parseRegistryImport(JSON.stringify({ models: [item] }))).toThrow("reserved");
});
it("bounds UTF8 bytes and count and keeps schema duplicate/capability validation", () => {
  expect(() => parseRegistryImport("汉".repeat(REGISTRY_BYTES / 2))).toThrow("too-large");
  expect(() => parseRegistryImport(JSON.stringify({ models: Array(501).fill(model) }))).toThrow(
    "too-large",
  );
  expect(() => parseRegistryImport(JSON.stringify({ models: [model, model] }))).toThrow("invalid");
  expect(() =>
    parseRegistryImport(JSON.stringify({ models: [{ ...model, capabilities: ["Bad Tag"] }] })),
  ).toThrow("invalid");
  expect(() => parseRegistryImport("{broken")).toThrow("invalid");
});
