import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Postgres integration tests share one database; run files serially there.
    fileParallelism: !process.env.YAP_TEST_PG_URL,
  },
});
