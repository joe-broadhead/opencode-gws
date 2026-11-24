import { defineConfig } from "vitest/config"

/**
 * Host integration suite: the real OpenCode runtime embedded in-process via
 * the `@opencode/sdk` 2.4.1 dev dependency (Node >= 24). Run with
 * `npm run test:host`.
 */
export default defineConfig({
  test: {
    setupFiles: ["test/host/setup.ts"],
    include: ["test/host/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
