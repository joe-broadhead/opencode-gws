import { describe, expect, it } from "vitest"
import type { Plugin } from "@opencode/plugin"
import { GMAIL_MCP_URL } from "../../src/provider/auth/mcp.js"
import { registerMcpAccounts } from "../../src/accounts.js"
import { manifest } from "../../src/manifest.js"
import { loadConfig } from "../../src/provider/domain/config.js"

const options = {
  accounts: {
    work: { enabledServices: ["gmail"] },
    personal: { mode: "access_token", enabledServices: ["drive"], tokenEnv: "GWS_PERSONAL_TOKEN" },
  },
}

interface FakeIntegration {
  id: string
  name: string
  methods: { id: string; type: string }[]
}

/** A context with the two transforms, one integration per server, and no connection yet. */
function fakeContext(rawOptions: Record<string, unknown>) {
  const integrations = new Map<string, FakeIntegration>()
  const servers = new Map<string, { name: string; integrationID: string; config: Record<string, unknown> }>()
  const integrationEditor = {
    get(id: string) {
      const found = integrations.get(id)
      return found === undefined ? undefined : { id: found.id, name: found.name }
    },
    update(id: string, update: (integration: FakeIntegration) => void) {
      const held = integrations.get(id) ?? { id, name: id, methods: [] }
      update(held)
      integrations.set(id, held)
    },
    method: {
      list(id: string) {
        return integrations.get(id)?.methods ?? []
      },
      update(input: { integrationID: string; method: { id: string; type: string } }) {
        const held = integrations.get(input.integrationID)
        if (held === undefined) throw new Error(`no integration ${input.integrationID}`)
        held.methods = held.methods.filter((method) => method.id !== input.method.id)
        held.methods.push({ id: input.method.id, type: input.method.type })
      },
      remove(id: string, method: { id: string }) {
        const held = integrations.get(id)
        if (held !== undefined) held.methods = held.methods.filter((item) => item.id !== method.id)
      },
    },
  }
  const mcpEditor = {
    set(name: string, config: Record<string, unknown>) {
      // The host names a server's integration itself; the plugin must follow that id, not the server name.
      const integrationID = `mcp_${name}`
      servers.set(name, { name, integrationID, config })
      if (!integrations.has(integrationID)) integrations.set(integrationID, { id: integrationID, name: integrationID, methods: [{ id: "host-oauth", type: "oauth" }] })
    },
  }
  const context = {
    options: rawOptions,
    agent: {},
    tool: {},
    session: {},
    permission: {},
    rpc: {},
    mcp: {
      transform: async (callback: (editor: typeof mcpEditor) => void) => {
        callback(mcpEditor)
        return { dispose: async () => undefined }
      },
      list: async () => ({ data: [...servers.values()] }),
    },
    integration: {
      transform: async (callback: (editor: typeof integrationEditor) => void) => {
        callback(integrationEditor)
        return { dispose: async () => undefined }
      },
      get: async ({ integrationID }: { integrationID: string }) => ({ data: integrations.get(integrationID) }),
    },
    event: {
      subscribe: () =>
        ({
          async *[Symbol.asyncIterator]() {
            // No event arrives in a test.
          },
        }) as AsyncIterable<never>,
    },
  }
  return { context: context as unknown as Plugin.Context, integrations, servers }
}

const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

describe("accounts", () => {
  it("names one server per alias by the contract's rule", () => {
    const config = loadConfig(options)
    expect(config.accounts.work?.mode).toBe("interactive")
    expect(config.accounts.personal?.mode).toBe("access_token")
  })

  it("registers one Gmail MCP server per alias and puts the plugin's sign-in on its integration", async () => {
    const fake = fakeContext(options)
    const config = loadConfig(options)
    const accounts = await registerMcpAccounts(fake.context, { manifest, config })
    try {
      expect(accounts.registration.problems).toEqual([])
      expect([...fake.servers.keys()]).toEqual(["gws-work", "gws-personal"])
      for (const server of fake.servers.values()) {
        expect(server.config).toMatchObject({ type: "remote", url: GMAIL_MCP_URL, oauth: {} })
      }
      await wait()
      for (const [alias, name] of [["work", "gws-work"], ["personal", "gws-personal"]] as const) {
        expect(accounts.integrations.get(alias)).toBe(`mcp_${name}`)
        const methods = fake.integrations.get(`mcp_${name}`)?.methods ?? []
        expect(methods.map((method) => method.id)).toContain("google")
        expect(methods.map((method) => method.id)).not.toContain("host-oauth")
      }
      expect(accounts.problems()).toEqual([])
    } finally {
      await accounts.dispose()
    }
  })
})
