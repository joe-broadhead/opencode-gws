import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/sdk"
import { expect, it } from "vitest"

/**
 * The built bundle in the real OpenCode 2.4.1 host: one Gmail MCP server per alias, and the plugin's Google sign-in on
 * the integration the host gives each server. The host does not reach Google in a test; it only has to create the
 * server and its integration, which is where the sign-in lives.
 */
const root = fileURLToPath(new URL("../../", import.meta.url))

async function isolatedHost(content: string) {
  const home = await mkdtemp(join(tmpdir(), "gws-mcp-"))
  process.env["HOME"] = home
  for (const key of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) process.env[key] = join(home, key.toLowerCase())
  const project = join(home, "project")
  const config = join(home, "config")
  await mkdir(project)
  await mkdir(config)
  const host = await OpenCode.create({
    config: { content, directory: config, project: false },
    app: { name: "opencode", version: "2.4.1" },
    models: { fetch: false },
    fs: { filewatcher: false },
    log: { level: "error", emit: () => undefined },
  })
  return {
    host,
    project,
    async close() {
      await host.close()
      await rm(home, { recursive: true, force: true })
    },
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

it("registers one Gmail MCP server per alias and attaches the Google sign-in", async () => {
  const edge = await isolatedHost(JSON.stringify({ plugins: [{ package: root, options: { accounts: { work: {}, personal: {} }, audit: { enabled: false } } }] }))
  try {
    const session = await edge.host.sessions.create({ location: { directory: edge.project } })
    await edge.host.sessions.prompt({ sessionID: session.id, text: "activate the gws plugin", delivery: "queue" }).catch(() => undefined)
    const deadline = Date.now() + 30_000
    interface ListedServer {
      readonly name: string
      readonly integrationID?: string
      readonly status: { readonly status: string }
    }
    let servers: readonly ListedServer[] = []
    for (;;) {
      servers = (await edge.host.mcp.list({ location: { directory: edge.project } })).data as ListedServer[]
      const names = servers.map((server) => server.name).sort()
      if (names.includes("gws-work") && names.includes("gws-personal")) break
      if (Date.now() > deadline) throw new Error(`the host registered ${names.join(", ") || "no server"}`)
      await wait(100)
    }
    const work = servers.find((server) => server.name === "gws-work")
    assert.ok(work?.integrationID, "the host gives the server its own integration")
    assert.notEqual(work.status.status, "disabled")

    // The attach is retried until the host has created the integration; poll for the Google method.
    const until = Date.now() + 15_000
    let last = ""
    for (;;) {
      try {
        const { data } = await edge.host.integration.get({ integrationID: work.integrationID })
        const methods = (data.methods as readonly { readonly type: string; readonly id: string }[]).map((method) => `${method.type}:${method.id}`)
        if (methods.includes("oauth:google")) {
          expect(methods.filter((method) => method.startsWith("oauth:"))).toEqual(["oauth:google"])
          break
        }
        last = methods.join(", ") || "no method"
      } catch (error) {
        last = error instanceof Error ? error.message : String(error)
      }
      if (Date.now() > until) {
        const listed = await edge.host.integration.list().catch(() => ({ data: [] as { id: string }[] }))
        throw new Error(`the integration ${work.integrationID} carries ${last}; the host lists ${(listed.data as readonly { readonly id: string }[]).map((entry) => entry.id).join(", ") || "nothing"}`)
      }
      await wait(200)
    }
  } finally {
    await edge.close()
  }
}, 60_000)
