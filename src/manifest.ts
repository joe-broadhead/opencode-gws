import { readFileSync } from "node:fs"
import { checkManifest, type Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"
import { GwsError } from "./provider/domain/errors.js"

/**
 * The installed package's manifest and version. OpenCode, the catalog and the kit read the same `capabilities` key
 * from `package.json`; the plugin checks it with the contract's schema here, so a corrupt package fails closed at
 * setup instead of drifting into a tool table.
 */
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string
  capabilities: unknown
}

export function assertManifest(value: unknown): Manifest {
  const checked = checkManifest(value)
  if (!checked.ok) {
    throw new GwsError("OPTIONS_INVALID", `package.json capabilities: ${checked.problems.join("; ")}`, {
      next: "Fix package.json capabilities; the plugin refuses to load until the contract accepts it.",
    })
  }
  return checked.value
}

export const manifest = assertManifest(pkg.capabilities)
export const packageVersion = pkg.version
