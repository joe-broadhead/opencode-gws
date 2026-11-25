import { accountStatuses, statusAnswer } from "@we-the-rebel-alliance/plugin-contract/accounts"
import type { MethodCall } from "@we-the-rebel-alliance/plugin-contract/register"
import type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"
import type { AccountView, RuntimeStatus } from "../provider/domain/status.js"
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { STATUS_OUTPUT } from "./schemas.js"
import type { StatusState } from "./state.js"

/**
 * The contract's `status` (contract §11): the plugin and host, one entry per alias, and the agents that lack the
 * generated access rules. It reads the provider's stored sign-ins and never calls Google.
 */
export function statusHandler(input: {
  readonly manifest: Manifest
  readonly version: string
  readonly state: StatusState
  readonly runtimeStatus: () => Promise<RuntimeStatus>
}): MethodHandler {
  return {
    description: "Read the plugin's state, its host range, and every account alias with its sign-in state.",
    input: { type: "object", properties: {}, additionalProperties: false },
    output: STATUS_OUTPUT,
    async run(_input, call) {
      const status = await input.runtimeStatus()
      const problems = [...input.state.accountProblems]
      const signals = Object.fromEntries(status.accounts.map((account) => [account.alias, signalOf(account)]))
      const aliases = status.accounts.map((account) => ({ alias: account.alias, profile: {} }))
      const accounts = accountStatuses(aliases, signals)
      return statusAnswer({
        manifest: input.manifest,
        version: input.version,
        hostVersion: input.state.hostVersion,
        accounts,
        problems,
        unguardedAgents: await unguardedAgents(call, problems),
      })
    },
  }
}

/**
 * The agents the generated rules do not reach. At this commit the call throws on a host read failure; the freeze
 * answers `{ ok, agents }` or `{ ok: false, error }`, and only this function changes.
 */
async function unguardedAgents(call: MethodCall, problems: string[]): Promise<readonly string[]> {
  try {
    return await call.unguardedAgents()
  } catch (error) {
    problems.push(`the agent list could not be read: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

/** One provider account as the contract's account signal: ready, needs_sign_in or error. */
function signalOf(account: AccountView): { state: "ready" | "needs_sign_in" | "error"; owner?: { id: string; label: string }; reason?: string } {
  if (account.needsAuth === true || !account.connected) {
    return { state: "needs_sign_in", ...(account.nextStep === undefined ? {} : { reason: account.nextStep }) }
  }
  if (account.email === undefined) return { state: "ready" }
  return { state: "ready", owner: { id: `mailto:${account.email}`, label: account.email } }
}
