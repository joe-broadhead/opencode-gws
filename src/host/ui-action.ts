import { auditErrorCode } from "../domain/audit.js"
import { GwsError } from "../domain/errors.js"
import { changed, previewText, type UiChange, UI_ACTION, uiAllowed, uiChange } from "../domain/ui-action.js"
import { PACKAGE_NAME } from "../domain/version.js"
import type { CallContext } from "../runtime/accounts.js"
import type { Runtime } from "../runtime/index.js"
import { ActionGrantRefused, type ActionPublicKey, personActs } from "./action-grant.js"

/**
 * Jelly's `commit` action, the one change a person may approve from a UI an agent made (`../domain/ui-action.ts`),
 * and its preview, `plan.preview`. Both live on the RPC named after the package (`./jelly-rpc.ts`); Jelly's core
 * plugin calls `act.commit` only for the host, with the grant it signed for the person's confirmed click.
 *
 * - `plan.preview` is gws's own plan of the exact input, dry-run and never stored, in words: it refuses when the
 *   option does not list the operation, when access is read-only, for any other operation or shape, and when the
 *   words would not fit Jelly's confirmation.
 * - `act.commit` checks the grant first (Jelly's key, this plugin, this action, this exact input, in time, once, from
 *   an owner device), then the same refusals, then plans and commits through the normal plan → commit path as the
 *   person: every policy rule, the admin gate and the recipient rules apply as for any plan. It answers what Google
 *   says changed. Every call, refused ones included, is a `ui.act` audit line with the grant's member and id.
 */

/** The parts of the runtime the action uses. */
type ActionRuntime = Pick<Runtime, "config" | "inspect" | "preview" | "plan" | "commit" | "audit">

export interface UiActionOptions {
  /** Jelly's action key, instead of the one Jelly publishes in the engine. */
  readonly key?: () => ActionPublicKey | undefined
  /** Seconds since the epoch; a test's clock. */
  readonly now?: () => number
  /** Told the preview text of the plan the commit runs, before it runs; a test's view. */
  readonly planned?: (text: string) => void
}

const request = (change: UiChange) => ({ account: change.account, operation: change.operation, params: change.params, body: change.body })

/** The plan must be a write: a later manifest that classified the operation otherwise is refused, not committed. */
function mustWrite(category: string, change: UiChange): void {
  if (category !== "write") {
    throw new GwsError("UI_ACTION_REFUSED", `${change.operation} is ${category}, and a UI may ask only for a write`, {
      next: "Make the change with gws_plan and the commit tool its plan names.",
    })
  }
}

/** The two methods, over `runtime`. Make one per plugin: its grant verifier remembers the grants it spent. */
export function uiAction(runtime: ActionRuntime, options: UiActionOptions = {}) {
  const acts = personActs({ pkg: PACKAGE_NAME, ...(options.key ? { key: options.key } : {}), ...(options.now ? { now: options.now } : {}) })

  const preview = async (input: unknown, signal?: AbortSignal): Promise<string> => {
    const change = uiChange(input)
    uiAllowed(runtime.config, change)
    const ctx: CallContext = { sessionId: "jelly-preview", agentId: "person", caller: "person", signal }
    mustWrite(runtime.inspect(request(change), "plan").category, change)
    const plan = await runtime.preview(request(change), ctx)
    mustWrite(plan.category, change)
    return previewText(plan, change)
  }

  const commit = async (call: unknown, signal?: AbortSignal) => {
    const started = Date.now()
    let person: { member: string; grant: string } | undefined
    let change: UiChange | undefined
    const audit = (outcome: "success" | "error" | "denied", errorCode?: string) =>
      runtime.audit.emit({
        event: "ui.act",
        outcome,
        account: change?.account,
        category: "write",
        operation: change?.operation,
        durationMs: Date.now() - started,
        caller: "person",
        ...(person ? { member: person.member, grant: person.grant } : {}),
        ...(errorCode ? { errorCode } : {}),
      })
    try {
      let granted: ReturnType<typeof acts.check>
      try {
        granted = acts.check(UI_ACTION, call)
      } catch (error) {
        if (error instanceof ActionGrantRefused) throw new GwsError("UI_GRANT_REFUSED", error.message)
        throw error
      }
      person = { member: granted.claims.mbr, grant: granted.claims.jti }
      change = uiChange(granted.input)
      uiAllowed(runtime.config, change)
      mustWrite(runtime.inspect(request(change), "plan").category, change)
      // The person's own plan, bound to this grant alone: nobody else can commit it.
      const ctx: CallContext = { sessionId: `jelly-act:${person.grant}`, agentId: "person", caller: "person", person, signal }
      const plan = await runtime.plan(request(change), ctx)
      mustWrite(plan.category, change)
      // The words of the plan the commit runs: the preview's own, so an oversized change is refused here too.
      options.planned?.(previewText(plan, change))
      const done = await runtime.commit("write", { planId: plan.planId }, ctx)
      audit("success")
      return changed(change, done.result)
    } catch (error) {
      const code = auditErrorCode(error)
      audit(["UI_GRANT_REFUSED", "UI_ACTION_OFF", "UI_ACTION_REFUSED", "POLICY_DENIED"].includes(code) ? "denied" : "error", code)
      throw error
    }
  }

  return { preview, commit }
}
