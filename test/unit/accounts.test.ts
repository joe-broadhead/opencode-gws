import { describe, expect, it } from "vitest"
import { registerAccounts } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { authFactory, integrationIds, integrationNames } from "../../src/accounts.js"
import { manifest } from "../../src/manifest.js"
import { loadConfig } from "../../src/provider/domain/config.js"

const options = {
  accounts: {
    work: { enabledServices: ["gmail"] },
    personal: { mode: "access_token", enabledServices: ["drive"], tokenEnv: "GWS_PERSONAL_TOKEN" },
  },
}

describe("accounts", () => {
  it("names one integration per alias by the contract's rule", () => {
    const config = loadConfig(options)
    expect([...integrationIds(config.accounts).entries()]).toEqual([
      ["work", "gws-work"],
      ["personal", "gws-personal"],
    ])
    expect([...integrationNames(config.accounts).entries()]).toEqual([
      ["work", "Google Workspace (work)"],
      ["personal", "Google Workspace (personal)"],
    ])
  })

  it("registers one integration per alias, with a sign-in method for the interactive one only", async () => {
    const config = loadConfig(options)
    const integrations = new Map<string, { id: string; name: string }>()
    const methods: Array<{ integrationID: string }> = []
    const ctx = {
      options,
      agent: {},
      tool: {},
      session: {},
      permission: {},
      rpc: {},
      integration: {
        transform: async (callback: (draft: unknown) => void) =>
          callback({
            update: (id: string, update: (ref: { id: string; name: string }) => void) => {
              const ref = integrations.get(id) ?? { id, name: id }
              update(ref)
              integrations.set(id, ref)
            },
            method: { update: (input: { integrationID: string }) => methods.push(input) },
          }),
      },
      mcp: { transform: async () => undefined },
    }
    const registered = await registerAccounts(ctx as never, { manifest, options, auth: authFactory(ctx as never, config) })
    expect(registered.problems).toEqual([])
    expect([...integrations.values()]).toEqual([
      { id: "gws-work", name: "Google Workspace (work)" },
      { id: "gws-personal", name: "Google Workspace (personal)" },
    ])
    expect(methods.map((method) => method.integrationID)).toEqual(["gws-work"])
  })

  it("refuses an alias outside the contract's pattern", () => {
    expect(() => loadConfig({ accounts: { Work: {} } })).toThrow(/accounts\.Work/)
  })
})
