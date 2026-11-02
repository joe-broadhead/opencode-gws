import { RequestInput } from "../domain/contract.js"
import { GwsError } from "../domain/errors.js"
import { Gws, type GwsAccount, type GwsStatus } from "../rpc.js"
import type { Runtime } from "../runtime/index.js"
import { permissionsBlock, unguardedAgents, type Rule } from "./agents.js"
import type { PluginContext } from "./context.js"

/**
 * The plugin's one status model and the `google-workspace.gws` RPC that
 * serves it. The RPC, the TUI dialog, /gws-status and gws_status all render
 * this model. The RPC also serves policy-gated reads for scripts that run
 * without a model. Nothing here can plan, approve or commit a change; that
 * stays with the commit tools and the OpenCode permission prompt they raise.
 */

/** An RPC read has no session or agent behind it; the audit marks it `caller: "rpc"`. */
const RPC_CALLER = { sessionId: "", agentId: "", caller: "rpc" } as const

export type StatusSource = (signal?: AbortSignal) => Promise<GwsStatus>

type AgentList = () => Promise<readonly { readonly id: string; readonly permissions: readonly Rule[] }[]>

/** The first thing to do: an account's sign-in, then the unguarded agents. */
function nextStep(accounts: readonly GwsAccount[], agents: readonly string[]): string | undefined {
  const account = accounts.find((entry) => entry.nextStep)
  if (account?.nextStep) return accounts.length > 1 ? `${account.alias}: ${account.nextStep}` : account.nextStep
  if (agents.length > 0) return "Put the permission block first in the own permissions of each agent without default rules, followed by your top-level rules for gws actions."
  return undefined
}

/** Plugin status with each account's sign-in state and the unguarded agents. Never a token or a client secret. */
export function statusSource(runtime: Runtime, listAgents: AgentList): StatusSource {
  return async (signal) => {
    const base = await runtime.status(signal)
    const agents = unguardedAgents(await runtime.wait(() => listAgents(), signal))
    const next = nextStep(base.accounts, agents)
    return {
      pluginVersion: base.pluginVersion,
      hostVersion: base.hostVersion,
      ...(base.hostWarning ? { hostWarning: base.hostWarning } : {}),
      gws: { path: base.binary.path, version: base.binary.version },
      services: base.services,
      accounts: base.accounts,
      auditDegraded: base.auditDegraded,
      unguardedAgents: agents,
      ...(agents.length > 0 ? { permissionsBlock: permissionsBlock(agents) } : {}),
      ...(next ? { nextStep: next } : {}),
    }
  }
}

export async function registerRpc(ctx: PluginContext, runtime: Runtime, status: StatusSource): Promise<() => Promise<void>> {
  const registration = await ctx.rpc.register(Gws, {
    status: async (_input, context) => runtime.wait((signal) => status(signal), context.signal),
    // The gws_read path without the permission assert: read() still resolves
    // the account and applies the plugin policy before anything runs.
    read: async (input, context) => {
      try {
        const parsed = RequestInput.safeParse(input)
        if (!parsed.success) {
          throw new GwsError("GWS_VALIDATION_ERROR", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "))
        }
        const output = await runtime.read(parsed.data, { ...RPC_CALLER, signal: context.signal })
        // RPC output must be a JSON value: drop undefined keys such as an unpaged read's pagination.
        return JSON.parse(JSON.stringify(output))
      } catch (error) {
        const known = GwsError.from(error)
        if (!known) throw error
        return context.error("failed", known.message, { code: known.code, next: known.next })
      }
    },
  })

  return async () => {
    await registration.dispose().catch(() => undefined)
  }
}
