import { Plugin } from "@opencode/plugin"
import { registerAccounts } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { assertHost, register } from "@we-the-rebel-alliance/plugin-contract/register"
import { authFactory, integrationAuthReporter, integrationConnection, integrationIds, integrationTokenProvider } from "./accounts.js"
import { createHandlers, type StatusState } from "./handlers/index.js"
import { manifest, packageVersion } from "./manifest.js"
import { loadConfig } from "./provider/domain/config.js"
import { Runtime } from "./provider/index.js"

/**
 * The plugin's one `register` call: the host gate, the provider, one integration per alias, and every method through
 * the contract's doors. No module registers a tool, an RPC id or a permission rule itself.
 */
export default Plugin.define({
  id: manifest.plugin.name,
  async setup(ctx) {
    assertHost(ctx, manifest)
    const config = loadConfig(ctx.options)
    const ids = integrationIds(config.accounts)
    const runtime = await Runtime.create(config, {
      pluginVersion: packageVersion,
      projectDirectory: ctx.location.directory,
      tokenProvider: integrationTokenProvider(ctx, config, ids),
      connection: integrationConnection(ctx, ids),
      onAuthState: integrationAuthReporter(ctx, config, ids),
    })

    let registration: Awaited<ReturnType<typeof register>> | undefined
    try {
      const accounts = await registerAccounts(ctx, {
        manifest,
        options: ctx.options as Record<string, unknown>,
        auth: authFactory(ctx, config),
      })
      const state: StatusState = {
        hostVersion: ctx.app.version,
        accountProblems: [...accounts.problems],
      }
      registration = await register(ctx, manifest, createHandlers({ runtime, manifest, version: packageVersion, state }))
      runtime.audit.emit({ event: "plugin.loaded", outcome: "success" })
      return async () => {
        await registration?.dispose().catch(() => undefined)
        await runtime.close()
      }
    } catch (error) {
      await registration?.dispose().catch(() => undefined)
      await runtime.close()
      throw error
    }
  },
})
