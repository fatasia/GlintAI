import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/studio/scripts/**/*.test.ts", "apps/web/**/*.test.ts"],
    environment: "node",
  },
});
