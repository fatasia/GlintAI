import { afterEach, expect, it, vi } from "vitest";
import { readStyleTrial, removeStyleTrial, saveStyleTrial } from "./style-trial";

const values = new Map<string, string>();
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
afterEach(() => { values.clear(); vi.unstubAllGlobals(); });

it("stores only the receipt, scoped by project, and never removes a newer receipt", () => {
  vi.stubGlobal("localStorage", storage);
  const receipt = { version: 1 as const, projectId: "工程/one", theme: "glint-dark" as const, requestId: "request-123456" };
  saveStyleTrial(receipt);
  expect(readStyleTrial(receipt.projectId)).toEqual(receipt);
  expect(readStyleTrial("other")).toBeNull();
  expect([...values.values()][0]).not.toContain("scenes");
  removeStyleTrial(receipt.projectId, "request-older");
  expect(readStyleTrial(receipt.projectId)).toEqual(receipt);
  removeStyleTrial(receipt.projectId, receipt.requestId);
  expect(readStyleTrial(receipt.projectId)).toBeNull();
});

it("rejects corrupted or mismatched stored receipts and propagates storage errors", () => {
  vi.stubGlobal("localStorage", storage);
  values.set("glint.style-trial.v1.p", "not json");
  expect(() => readStyleTrial("p")).toThrow();
  values.set("glint.style-trial.v1.p", JSON.stringify({ version: 1, projectId: "q", theme: "glint-dark", requestId: "request-123456" }));
  expect(() => readStyleTrial("p")).toThrow();
  vi.stubGlobal("localStorage", { ...storage, setItem: () => { throw new Error("quota"); } });
  expect(() => saveStyleTrial({ version: 1, projectId: "p", theme: "glint-dark", requestId: "request-123456" })).toThrow("quota");
});
