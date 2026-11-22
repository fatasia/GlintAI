import { defineConfig } from "vitest/config";

// CI injects GLINT_CI_SLOW for hosted runners that are 2-4x slower than a dev
// box; this scales the default per-test budget only. Tests with explicit
// timeouts scale their own constants, and no assertion depends on wall time.
const slowScale = process.env.GLINT_CI_SLOW ? 3 : 1;

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}", "apps/studio/scripts/**/*.test.{ts,tsx}", "apps/web/**/*.test.{ts,tsx}", "apps/desktop/scripts/**/*.test.{ts,tsx}"],
    environment: "node",
    testTimeout: 5_000 * slowScale,
    hookTimeout: 10_000 * slowScale,
    // Many integration files launch Chromium, Git or FFmpeg. CPU-count worker
    // defaults oversubscribe those child processes and can outlive test timeouts.
    maxWorkers: 2,
    minWorkers: 1,
    setupFiles: ["./apps/web/server/test-isolation.ts"],
  },
});
