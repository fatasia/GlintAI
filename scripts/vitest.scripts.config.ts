// Tests for the repo-level guard scripts in scripts/. Kept separate from vitest.config.ts so
// the main suite's include list (and its worker limits) stay untouched.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts"],
    environment: "node",
    // Each test builds real git repositories; keep them from oversubscribing the disk.
    maxWorkers: 2,
    minWorkers: 1,
    testTimeout: 30_000,
  },
});
