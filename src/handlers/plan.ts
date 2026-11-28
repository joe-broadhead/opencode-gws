import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { GwsError } from "../provider/domain/errors.js"
import type { CommitCategory } from "../provider/domain/types.js"
import type { Runtime } from "../provider/index.js"
import { throwRefusal } from "./errors.js"
import { refuseGmailMcp } from "./mcp.js"
import { PLAN_INPUT, PLAN_OUTPUT } from "./schemas.js"

/** A recipient the preview shows, in the contract's `reaches` shape. */
function reaches(preview: { readonly recipients?: readonly string[]; readonly recipientsUnknown?: string }): { id: string; label?: string }[] | undefined {
  if (preview.recipients === undefined || preview.recipients.length === 0) return undefined
  return preview.recipients.slice(0, 20).map((address) => ({ id: address }))
}

/**
 * `plan_<category>`: a gws dry run for one commit class that writes nothing. The answer is the person's preview (the
 * redacted command and Google's dry-run answer) and the private plan id the matching commit reads from `call.plan`;
 * the register mints the public planId. An operation whose effective category is another class is refused.
 */
export function planHandler(runtime: Runtime, category: CommitCategory): MethodHandler {
  return {
    description:
      `Plan one ${category} change without making it: a gws dry run whose preview names the exact operation, recipients and destination. ` +
      `Show it to the person, then commit with ${category}, passing only the planId.`,
    input: PLAN_INPUT,
    output: PLAN_OUTPUT,
    async run(input, call) {
      try {
        const operation = String((input as Record<string, unknown>)["operation"] ?? "")
        refuseGmailMcp(runtime, operation, call.account, `plan_${category}`)
        const target = runtime.inspect({ ...(input as Record<string, unknown>), account: call.account } as never, "plan")
        if (target.category !== category) {
          throw new GwsError("CATEGORY_MISMATCH", `plan_${category} plans only ${category} operations, and ${target.operation} is ${target.category}`, {
            next: target.category === "read" ? "Plan a read with read." : `Use plan_${target.category} for this operation.`,
          })
        }
        const plan = await runtime.plan({ ...(input as Record<string, unknown>), account: call.account } as never, {
          sessionId: call.sessionID,
          agentId: call.agent,
          signal: call.signal,
          progress: (update) => void call.progress(update as unknown as Record<string, unknown>),
          ...(call.door === "rpc" ? { caller: "rpc" as const } : {}),
        })
        const preview = plan.preview
        const changes = [
          `${target.category} ${target.operation} on ${target.account}`,
          ...(preview.destination === undefined ? [] : [`Write ${preview.destination}`]),
          ...(preview.uploads === undefined ? [] : [`Upload ${preview.uploads.length} file${preview.uploads.length === 1 ? "" : "s"}`]),
          ...(preview.recipientsUnknown === undefined ? [] : [`Recipients unknown: ${preview.recipientsUnknown}`]),
        ].slice(0, 20)
        return {
          method: category,
          output: { operation: target.operation, category: plan.category, preview, dryRun: plan.dryRun },
          changes,
          ...(reaches(preview) === undefined ? {} : { reaches: reaches(preview) }),
          trust: "untrusted",
          // Private plan data: the commit reads this, never a value the person did not see.
          gwsPlanId: plan.planId,
          gwsExpiresAt: plan.expiresAt,
        }
      } catch (error) {
        return throwRefusal(error, `plan_${category}`)
      }
    },
  }
}
