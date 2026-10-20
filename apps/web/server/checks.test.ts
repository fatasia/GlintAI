import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCheckStore } from "./checks.mjs";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
it("grades explicit questions, deduplicates submissions and persists local aggregate counts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-checks-test-")); dirs.push(dir);
  const store = createCheckStore(dir), questions = store.questions("entropy");
  expect(questions).toHaveLength(2); expect(JSON.stringify(questions)).not.toContain('"answer":');
  const input = { attemptId: "test-attempt-123", answers: [{ id: "isolated", choice: 1 }, { id: "life", choice: 0 }] };
  expect(store.submit("entropy", input).correct).toBe(1); store.submit("entropy", input);
  expect(store.stats("entropy").attempts).toBe(1);
  expect(createCheckStore(dir).stats("entropy").concepts[1].missed).toBe(1);
  expect(store.questions("toString")).toBeNull(); expect(store.stats("toString")).toBeNull();
  expect(() => store.submit("entropy", { ...input, attemptId: "different-123", answers: [{ id: "life", choice: 99 }, { id: "life", choice: 0 }] })).toThrow();
});
