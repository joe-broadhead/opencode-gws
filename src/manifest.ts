import { readFileSync } from "node:fs"
import type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"

/**
 * The installed package's manifest and version. OpenCode, the catalog and the kit read the same `capabilities` key
 * from `package.json`; the plugin reads it here so its handlers and its declaration cannot drift.
 */
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string
  capabilities: Manifest
}

export const manifest = pkg.capabilities
export const packageVersion = pkg.version
