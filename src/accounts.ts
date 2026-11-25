import type { Credential, Plugin } from "@opencode/plugin"
import { googleIntegration, type GoogleIntegrationDefinition } from "./provider/auth/integration.js"
import { readSignIn, renewableSignIn, signInClient } from "./provider/auth/credential.js"
import type { ConnectionView } from "./provider/auth/status.js"
import { integrationIds, integrationNames } from "./provider/auth/google.js"
import type { AccountCredential } from "./provider/accounts.js"
import { AuthStateTracker, type AuthState } from "./provider/domain/auth-state.js"
import { Lifecycle } from "./provider/domain/lifecycle.js"
import type { PluginConfig } from "./provider/domain/types.js"

/**
 * The integration mechanism's host wiring: one OpenCode integration per account alias (contract §5), the sign-in
 * methods `registerAccounts` installs, the token and connection the provider reads at call time, and the auth-state
 * reports the host shows natively.
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

/** The auth methods `registerAccounts` installs for one alias: none for a headless account. */
export function authFactory(ctx: Plugin.Context, config: PluginConfig): (account: { readonly alias: string }, integrationID: string) => readonly { readonly integrationID: string; readonly [key: string]: unknown }[] {
  const lifetime = new Lifecycle()
  const resolve = connectionResolver(ctx, lifetime)
  return (account, integrationID) => {
    const profile = config.accounts[account.alias]
    if (profile === undefined || profile.mode !== "interactive") return []
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
