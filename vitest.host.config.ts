import { defineConfig } from "vitest/config"

/**
 * Host integration suite: the built bundle in the real OpenCode 2.4.1 host through the contract's harness (Node >= 24).
 * Run with `npm run test:host`.
 */
export default defineConfig({
  test: {
    include: ["test/host/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
