import type { Credential, Plugin } from "@opencode/plugin"
import { accountLabel, registerAccounts, type AccountsRegistration } from "@we-the-rebel-alliance/plugin-contract/accounts"
import type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"
import { gmailMcpServer } from "./provider/auth/mcp.js"
import { googleIntegration, type GoogleIntegrationDefinition } from "./provider/auth/integration.js"
import { readSignIn, renewableSignIn, signInClient } from "./provider/auth/credential.js"
import type { ConnectionView } from "./provider/auth/status.js"
import { GOOGLE_METHOD_ID, integrationIds, integrationNames } from "./provider/auth/google.js"
import type { AccountCredential } from "./provider/accounts.js"
import { AuthStateTracker, type AuthState } from "./provider/domain/auth-state.js"
import { Lifecycle } from "./provider/domain/lifecycle.js"
import type { PluginConfig } from "./provider/domain/types.js"

/**
 * The host wiring for the `mcp` account mechanism (contract §5): one Google Workspace server per alias, named by the
 * contract's rule, and the plugin's Google sign-in on the integration OpenCode gives that server. The token and
 * connection the provider reads at call time come from the same integration, so the plugin's sources and remaining
 * operations use the grant the Gmail server's tools use. Auth-state reports are shown natively on that integration.
 */

/** Rethrow unchanged: the OAuth module already writes the contract's codes. */
function rethrow(error: unknown): never {
  throw error
}

/** The Google flow returns the host credential shape minus the method-id brand. */
function toHostCredential(credential: { type: "oauth"; methodID: string; refresh: string; access: string; expires: number; metadata?: Record<string, unknown> }): Credential.OAuth {
  return credential as Credential.OAuth
}

/** The active connection's OAuth credential, refreshed by the host when it is about to expire. */
function connectionResolver(ctx: Plugin.Context, lifetime: Lifecycle) {
  return async (integrationID: string, signal?: AbortSignal): Promise<Credential.OAuth | undefined> => {
    const connection = await lifetime.wait(() => ctx.integration.connection.active(integrationID), signal)
    if (signal?.aborted || !connection) return undefined
    const credential = await lifetime.wait(() => ctx.integration.connection.resolve(connection), signal)
    return credential?.type === "oauth" ? credential : undefined
  }
}

/**
 * The auth method the plugin installs on an alias's MCP server integration. It is offered for every profile, including
 * a headless one: the server is an MCP client's, and a person who wants its tools signs in once. A headless profile's
 * own gws calls keep using `credentialsFileEnv` or `tokenEnv`, as before.
 */
export function authFactory(ctx: Plugin.Context, config: PluginConfig): (account: { readonly alias: string }, integrationID: string) => readonly { readonly integrationID: string; readonly [key: string]: unknown }[] {
  const lifetime = new Lifecycle()
  const resolve = connectionResolver(ctx, lifetime)
  return (account, integrationID) => {
    const profile = config.accounts[account.alias]
    if (profile === undefined) return []
    const definition: GoogleIntegrationDefinition = googleIntegration(account.alias, profile, integrationID, {
      pluginClient: config.oauthClient,
      redirect: config.redirect,
      previous: async () => {
        // Only a sign-in that kept its client secret has a client to reuse.
        const signIn = renewableSignIn((await resolve(integrationID))?.metadata)
        return signIn ? signInClient(signIn) : undefined
      },
    })
    return [
      {
        integrationID,
        method: definition.method,
        authorize: async (answer: Record<string, unknown>) => {
          const authorization = await definition.authorize(answer).catch(rethrow)
          return { ...authorization, callback: authorization.callback.then(toHostCredential, rethrow) }
        },
        refresh: async (credential: Parameters<GoogleIntegrationDefinition["refresh"]>[0]) => toHostCredential(await definition.refresh(credential).catch(rethrow)),
        label: definition.label,
      },
    ]
  }
}

/** The part of `ctx.integration.transform`'s editor this module uses, so the host types stay in setup. */
interface IntegrationEditor {
  get(id: string): { readonly id: string; name: string } | undefined
  update(id: string, update: (integration: { readonly id: string; name: string }) => void): void
  readonly method: {
    list(id: string): readonly { readonly id: string; readonly type: string }[]
    remove(id: string, method: { readonly id: string }): void
    update(input: Readonly<Record<string, unknown>>): void
  }
}

/** What registering the servers and attaching the plugin's sign-in did, and what it could not. */
export interface McpAccounts {
  /** One integration id per alias, filled as OpenCode creates each server's integration. */
  readonly integrations: Map<string, string>
  readonly registration: AccountsRegistration
  problems(): readonly string[]
  dispose(): Promise<void>
}

const MCP_STARTUP_POLL_MS = 250
const MCP_STARTUP_WINDOW_MS = 10_000
const MCP_RESUBSCRIBE_MS = 5_000

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Calls `handle` for each event of `types` until `signal` aborts or the stream ends. */
async function forEachIntegrationEvent(
  subscribe: Plugin.Context["event"]["subscribe"],
  signal: AbortSignal,
  handle: () => void,
): Promise<void> {
  const iterator = subscribe({ types: ["integration.updated"], signal })[Symbol.asyncIterator]()
  let stop = () => {}
  const aborted = new Promise<undefined>((resolve) => {
    stop = () => resolve(undefined)
  })
  signal.addEventListener("abort", stop, { once: true })
  try {
    while (!signal.aborted) {
      const result = await Promise.race([iterator.next(), aborted])
      if (!result || result.done) return
      handle()
    }
  } finally {
    signal.removeEventListener("abort", stop)
    void iterator.return?.()?.catch(() => undefined)
  }
}

/** Waits `ms`, or less if `signal` aborts first. Never rejects. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

/**
 * Register one Google Workspace MCP server per alias and put the plugin's Google sign-in on each server's integration.
 *
 * OpenCode creates a server's integration after `registerAccounts` returns, so the attach is retried for a short
 * startup window and again whenever an integration changes. A failure is recorded for status, never thrown: a server
 * whose sign-in could not be attached still appears, and status names the problem.
 *
 * The server's own generic OAuth method is removed: Google requires an OAuth client marked for an AI agent, and the
 * plugin's form is where the person enters it. The Gmail MCP endpoint is the one server this plugin builds on; the
 * remaining Google services stay on the pinned gws executable.
 */
export async function registerMcpAccounts(
  ctx: Plugin.Context,
  request: { readonly manifest: Manifest; readonly config: PluginConfig; readonly integrations?: Map<string, string> },
): Promise<McpAccounts> {
  const serverNames = integrationIds(request.config.accounts)
  const integrations = request.integrations ?? new Map<string, string>()
  for (const [alias, name] of serverNames) if (!integrations.has(alias)) integrations.set(alias, name)
  const registration = await registerAccounts(ctx, {
    manifest: request.manifest,
    options: ctx.options as Readonly<Record<string, unknown>> | undefined,
    server: () => gmailMcpServer(),
  })
  const problems = [...registration.problems]
  const stopped = new AbortController()
  const attached = new Map<string, { readonly id: string; dispose: () => Promise<void> }>()

  const serverIntegration = async (name: string): Promise<string | undefined> => {
    try {
      return (await ctx.mcp.list()).data.find((server) => server.name === name)?.integrationID
    } catch {
      return undefined
    }
  }

  const genericReturned = async (id: string): Promise<boolean> => {
    try {
      const { data } = await ctx.integration.get({ integrationID: id })
      return data.methods.some((method) => method.type === "oauth" && method.id !== GOOGLE_METHOD_ID)
    } catch {
      return false
    }
  }

  const attach = async (alias: string, name: string): Promise<void> => {
    const id = await serverIntegration(name)
    if (id === undefined || stopped.signal.aborted) return
    const held = attached.get(alias)
    if (held?.id === id && !(await genericReturned(id))) return
    const methods = authFactory(ctx, request.config)({ alias }, id)
    if (methods.length === 0) return
    const next = await ctx.integration.transform((raw: unknown) => {
      const editor = raw as IntegrationEditor
      // The host creates the server's integration after setup; the poller retries until it exists.
      if (editor.get(id) === undefined) return
      editor.update(id, (integration) => {
        integration.name = accountLabel(request.manifest.plugin.title, alias)
      })
      for (const method of editor.method.list(id)) {
        if (method.type === "oauth" && method.id !== GOOGLE_METHOD_ID) editor.method.remove(id, method)
      }
      for (const method of methods) editor.method.update({ ...method, integrationID: id })
    })
    integrations.set(alias, id)
    const previous = attached.get(alias)
    attached.set(alias, { id, dispose: () => next.dispose() })
    await previous?.dispose().catch(() => undefined)
  }

  let checking: Promise<void> | undefined
  let again = false
  const check = async (): Promise<void> => {
    for (const [alias, name] of serverNames) {
      if (stopped.signal.aborted) return
      try {
        await attach(alias, name)
      } catch (error) {
        const reason = `accounts.${alias}: the Gmail MCP server's sign-in could not be attached: ${messageOf(error)}`
        if (!problems.includes(reason)) problems.push(reason)
      }
    }
  }
  const schedule = (): Promise<void> => {
    if (checking) {
      again = true
      return checking
    }
    checking = (async () => {
      do {
        again = false
        if (!stopped.signal.aborted) await check().catch(() => undefined)
      } while (again)
    })().finally(() => {
      checking = undefined
    })
    return checking
  }

  const listen = (async () => {
    while (!stopped.signal.aborted) {
      await forEachIntegrationEvent(ctx.event.subscribe, stopped.signal, () => void schedule()).catch(() => undefined)
      if (!stopped.signal.aborted) void schedule()
      await wait(MCP_RESUBSCRIBE_MS, stopped.signal)
    }
  })()
  const startup = (async () => {
    const until = Date.now() + MCP_STARTUP_WINDOW_MS
    while (!stopped.signal.aborted && Date.now() < until) {
      await schedule()
      await wait(MCP_STARTUP_POLL_MS, stopped.signal)
    }
  })()

  return {
    integrations,
    registration,
    problems: () => problems,
    async dispose() {
      stopped.abort()
      await Promise.allSettled([startup, listen])
      for (const entry of attached.values()) await entry.dispose().catch(() => undefined)
    },
  }
}

/**
 * Resolve an interactive account's current sign-in at call time: the access token, which goes only into the gws child
 * environment, and the scopes Google granted.
 */
export function integrationTokenProvider(
  ctx: Plugin.Context,
  config: PluginConfig,
  ids: ReadonlyMap<string, string>,
): (account: string, signal?: AbortSignal) => Promise<AccountCredential | undefined> {
  const lifetime = new Lifecycle()
  const resolve = connectionResolver(ctx, lifetime)
  return async (account, signal) => {
    if (signal?.aborted) return undefined
    const id = ids.get(account)
    if (!id || config.accounts[account]?.mode !== "interactive") return undefined
    const credential = await resolve(id, signal)
    if (signal?.aborted || !credential) return undefined
    const signIn = readSignIn(credential.metadata)
    if (!signIn) throw new Error(`the stored sign-in for '${account}' has no scope record`)
    return { access: credential.access, grantedScopes: signIn.grantedScopes }
  }
}

/**
 * Whether the host shows this connection as needing a sign-in. `connection.active` returns the credential alone, so the
 * status the host keeps is read from the connection `integration.get` projects.
 */
async function showsNeedsAuth(ctx: Plugin.Context, integrationID: string, connectionID: string): Promise<boolean> {
  try {
    const { data } = await ctx.integration.get({ integrationID })
    const shown = data.connections?.find((item) => item.type === "credential" && item.id === connectionID)
    return shown?.type === "credential" && shown.status?.status === "needs_auth"
  } catch {
    return false
  }
}

/** An interactive account's connection for status; never a token or a client secret. */
export function integrationConnection(ctx: Plugin.Context, ids: ReadonlyMap<string, string>): (account: string, signal?: AbortSignal) => Promise<ConnectionView> {
  const lifetime = new Lifecycle()
  return async (account, signal) => {
    const id = ids.get(account)
    if (!id) return { connected: false, needsAuth: false }
    const connection = await lifetime.wait(() => ctx.integration.connection.active(id), signal)
    if (!connection) return { connected: false, needsAuth: false }
    const needsAuth = connection.type === "credential" && (await lifetime.wait(() => showsNeedsAuth(ctx, id, connection.id), signal))
    let credential: Credential.Value | undefined
    try {
      credential = await lifetime.wait(() => ctx.integration.connection.resolve(connection), signal)
    } catch {
      return { connected: true, needsAuth: true }
    }
    const signIn = credential?.type === "oauth" ? readSignIn(credential.metadata) : undefined
    return {
      connected: true,
      needsAuth,
      ...(signIn
        ? {
            signIn: {
              access: signIn.access,
              ...(signIn.clientSource ? { clientSource: signIn.clientSource } : {}),
              grantedScopes: signIn.grantedScopes,
              ...(signIn.email ? { email: signIn.email } : {}),
              ...(signIn.domain ? { domain: signIn.domain } : {}),
            },
          }
        : {}),
    }
  }
}

/**
 * Report sign-in problems on the account's active connection, so the host shows them natively (`needs_auth`), and clear
 * them after the next good call. Only transitions reach the host; reports for one account run in order, and a failed
 * report is retried on the next observation.
 */
export function integrationAuthReporter(
  ctx: Plugin.Context,
  config: PluginConfig,
  ids: ReadonlyMap<string, string>,
): (account: string, state: AuthState, signal?: AbortSignal) => Promise<void> {
  const tracker = new AuthStateTracker()
  const lifetime = new Lifecycle()
  const queues = new Map<string, Promise<void>>()
  return (account, state, signal) => {
    if (signal?.aborted) return Promise.resolve()
    const integrationID = ids.get(account)
    if (!integrationID || config.accounts[account]?.mode !== "interactive" || !tracker.update(account, state)) return Promise.resolve()
    const report = async (): Promise<void> => {
      try {
        if (signal?.aborted) return
        const connection = await lifetime.wait(() => ctx.integration.connection.active(integrationID), signal)
        if (signal?.aborted) return
        if (!connection) {
          tracker.forget(account)
          return
        }
        await lifetime.wait(
          () =>
            ctx.integration.connection.status({
              integrationID,
              connection,
              status: state.status === "ok" ? undefined : { status: "needs_auth", message: state.message },
            }),
          signal,
        )
      } catch {
        tracker.forget(account)
      }
    }
    const next = (queues.get(account) ?? Promise.resolve()).then(report)
    queues.set(account, next)
    return next
  }
}

export { integrationIds, integrationNames }
