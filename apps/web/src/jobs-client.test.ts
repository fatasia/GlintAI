import { expect, it } from "vitest";
import { parseJob, terminalJob } from "./jobs-client";
it("validates recovery responses and derives same-origin media links", () => {
  expect(() => parseJob({ id: "../../secret", status: "done", log: [] })).toThrow();
  expect(() => parseJob({ id: "idea-test", status: "unknown", log: [] })).toThrow();
  const job = parseJob({ id: "idea-test", status: "done", log: [], video: "https://attacker.invalid" });
  expect(job.video).toBe("/api/video/idea-test"); expect(terminalJob(job)).toBe(true);
  expect(terminalJob({ ...job, status: "cancelling" })).toBe(false);
});
