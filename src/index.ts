import { Plugin } from "@opencode/plugin"
import { assertHost, register } from "@we-the-rebel-alliance/plugin-contract/register"
import { integrationAuthReporter, integrationConnection, integrationTokenProvider, registerMcpAccounts } from "./accounts.js"
import { createHandlers, type StatusState } from "./handlers/index.js"
import { manifest, packageVersion } from "./manifest.js"
import { loadConfig } from "./provider/domain/config.js"
import { Runtime } from "./provider/index.js"
import { registerSkills } from "./skills.js"

/**
 * The plugin's one `register` call: the host gate, the provider, one Gmail MCP server per alias, and every method
 * through the contract's doors. No module registers a tool, an RPC id or a permission rule itself.
 */
export default Plugin.define({
  id: manifest.plugin.name,
  async setup(ctx) {
    assertHost(ctx, manifest)
    const config = loadConfig(ctx.options)
    // Filled as OpenCode creates each alias's MCP server integration; the provider reads the same map.
    const integrations = new Map<string, string>()
    const runtime = await Runtime.create(config, {
      pluginVersion: packageVersion,
      projectDirectory: ctx.location.directory,
      integrationIds: integrations,
      tokenProvider: integrationTokenProvider(ctx, config, integrations),
      connection: integrationConnection(ctx, integrations),
      onAuthState: integrationAuthReporter(ctx, config, integrations),
    })

    let skillsRegistration: Awaited<ReturnType<typeof registerSkills>> | undefined
    let accounts: Awaited<ReturnType<typeof registerMcpAccounts>> | undefined
    let registration: Awaited<ReturnType<typeof register>> | undefined
    try {
      skillsRegistration = await registerSkills(ctx)
      accounts = await registerMcpAccounts(ctx, { manifest, config, integrations })
      const state: StatusState = {
        hostVersion: ctx.app.version,
        accountProblems: [...accounts.problems()],
      }
      registration = await register(ctx, manifest, createHandlers({ runtime, manifest, version: packageVersion, state }))
      runtime.audit.emit({ event: "plugin.loaded", outcome: "success" })
      return async () => {
        await skillsRegistration?.dispose().catch(() => undefined)
        await registration?.dispose().catch(() => undefined)
        await accounts?.dispose().catch(() => undefined)
        await runtime.close()
      }
    } catch (error) {
      await skillsRegistration?.dispose().catch(() => undefined)
      await registration?.dispose().catch(() => undefined)
      await accounts?.dispose().catch(() => undefined)
      await runtime.close()
      throw error
    }
  },
})
