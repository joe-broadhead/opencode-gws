import { createHost, type HostRun } from "@we-the-rebel-alliance/plugin-contract/kit"
import { rulesFor, type AccessLevel } from "@we-the-rebel-alliance/plugin-contract/access"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect } from "vitest"

const root = join(import.meta.dirname, "..", "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  capabilities: never
}

export async function accessHost(access: AccessLevel): Promise<HostRun> {
  return createHost({
    directory: root,
    version: "2.4.1",
    pluginId: "gws",
    options: { accounts: { work: {}, personal: {} }, audit: { enabled: false }, access },
  })
}

/** The contract's generated block for a level, after the agent's base allow. */
export function expectAccessBlock(run: HostRun, access: AccessLevel): void {
  const build = run.agents.find((agent) => agent.id === "build")
  expect(build).toBeDefined()
  const expected = rulesFor(pkg.capabilities, access, ["work", "personal"])
  expect(build?.permissions[0]).toMatchObject({ action: "*", resource: "*", effect: "allow" })
  expect(build?.permissions.slice(1, 1 + expected.length)).toEqual(expected)
}

export const writeRule = (effect: "allow" | "deny") => ({ action: "gws.write", resource: "*", effect })
