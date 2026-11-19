import { expect, it } from "vitest";
import { requireTaskApproval } from "./task-approval";
const binding = {
  planDigest: "1".repeat(64),
  inputDigest: "2".repeat(64),
  projectDigest: "3".repeat(64),
  stepsDigest: "4".repeat(64),
  quoteDigest: "5".repeat(64),
};
it("binds every approval field and rejects extra authority", () => {
  const approval = {
    format: "glint-task-approval",
    version: 1,
    ...binding,
    confirmedAt: "2026-11-03T00:00:00.000Z",
  };
  expect(requireTaskApproval(approval, binding)).toEqual(approval);
  for (const key of Object.keys(binding))
    expect(() => requireTaskApproval({ ...approval, [key]: "0".repeat(64) }, binding)).toThrow();
  expect(() => requireTaskApproval({ ...approval, allowUnknown: true }, binding)).toThrow();
});
