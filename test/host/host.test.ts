import { describe, expect, it } from "vitest"
import { createHost } from "@we-the-rebel-alliance/plugin-contract/kit"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dirname, "..", "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  capabilities: { plugin: { name: string; summary: string } }
}

/**
 * The built bundle in the real OpenCode 2.4.1 host: every method is a tool and an RPC method, the two-account refusals
 * come from the contract, and status answers its declared shape. `plugin-kit check` runs the same host for T1; this
 * suite proves the plugin-specific answers on it.
 */
describe("OpenCode 2.4.1 host", () => {
  it("loads the built bundle, registers the methods, and answers status and the account refusals", async () => {
    const run = await createHost({
      directory: root,
      version: "2.4.1",
      pluginId: pkg.capabilities.plugin.name,
      options: { accounts: { work: {}, personal: {} }, audit: { enabled: false } },
    })
    try {
      expect(run.refusal).toBeUndefined()
      expect(run.failure).toBeUndefined()
      expect(run.definition?.id).toBe("gws")
      expect(run.namespace?.description).toBe(pkg.capabilities.plugin.summary)
      expect(run.tools).toHaveLength(16)
      expect(run.rpc?.id).toBe("gws")
      expect([...(run.rpc?.events ?? [])]).toEqual(["changed"])

      const status = await run.call("status", {})
      expect(status.ok).toBe(true)
      if (status.ok) {
        expect(status.output).toMatchObject({ name: "gws", host: { version: "2.4.1", range: ">=2.4.1 <2.5.0", tested: ["2.4.1"] } })
        expect((status.output as { accounts: unknown[] }).accounts).toHaveLength(2)
      }

      const missing = await run.call("events_list", {})
      expect(missing).toMatchObject({ ok: false, code: "ACCOUNT_REQUIRED" })
      const unknown = await run.call("events_list", { account: "nobodyhere" })
      expect(unknown).toMatchObject({ ok: false, code: "ACCOUNT_UNKNOWN" })
      const probe = await run.call("probe", { source: "gmail", account: "work" })
      expect(probe).toMatchObject({ ok: false, code: "NEEDS_SIGN_IN" })
    } finally {
      await run.close()
    }
  })
})
