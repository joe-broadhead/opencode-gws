import { readFileSync } from "node:fs"
import { defineConfig } from "vitest/config"

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }

export default defineConfig({
  define: { __PLUGIN_VERSION__: JSON.stringify(version) },
  test: {
    include: ["test/unit/**/*.test.ts"],
    // The host suite has its own config: npm run test:host.
    exclude: ["test/host/**", "**/node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
