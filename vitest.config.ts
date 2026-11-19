import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/studio/scripts/**/*.test.ts", "apps/web/**/*.test.ts", "apps/desktop/scripts/**/*.test.ts"],
    environment: "node",
    // Many integration files launch Chromium, Git or FFmpeg. CPU-count worker
    // defaults oversubscribe those child processes and can outlive test timeouts.
    maxWorkers: 2,
    minWorkers: 1,
    setupFiles: ["./apps/web/server/test-isolation.ts"],
  },
});
