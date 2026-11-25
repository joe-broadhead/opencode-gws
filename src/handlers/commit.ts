import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import type { CommitCategory } from "../provider/domain/types.js"
import type { Runtime } from "../provider/index.js"
import { throwRefusal } from "./errors.js"
import { COMMIT_OUTPUT } from "./schemas.js"

/** The source ids a write changes, by operation; none when no declared source changes. */
function capabilitiesOf(operation: string): string[] {
  const gmail =
    operation.startsWith("gmail.users.messages.") ||
    operation.startsWith("gmail.users.threads.") ||
    operation === "gmail.users.drafts.send" ||
    operation === "gmail.send" ||
    operation === "gmail.forward" ||
    operation.startsWith("gmail.reply")
  if (gmail) return ["gws.gmail"]
  if (operation.startsWith("calendar.events.")) return ["gws.calendar", "gws.calendar.today"]
  return []
}

/**
 * One commit tool per class (LD-6). The contract's register confirms it and hands the plan handler's full answer as
 * `call.plan`; this handler reads only the private gws plan id, applies exactly that plan, and nudges the sources the
 * write actually changes.
 */
export function commitHandler(runtime: Runtime, category: CommitCategory): MethodHandler {
  return {
    description:
      category === "admin"
        ? "Commit one admin plan, if the plugin's admin setting allows the operation. Pass only the planId."
        : `Commit one ${category} plan from plan, exactly as its preview shows. Pass only the planId.`,
    input: { type: "object", properties: { planId: { type: "string", minLength: 1 } }, required: ["planId"], additionalProperties: false },
    output: COMMIT_OUTPUT,
    async run(_input, call) {
      const plan = call.plan !== null && typeof call.plan === "object" ? (call.plan as Record<string, unknown>) : {}
      const planId = typeof plan["gwsPlanId"] === "string" ? plan["gwsPlanId"] : undefined
      if (planId === undefined) {
        return throwRefusal(new Error("PLAN_INVALID: the plan carries no gws plan id. Next step: Plan the change again."), category)
      }
      try {
        const answer = await runtime.commit(category, { planId }, {
          sessionId: call.sessionID,
          agentId: call.agent,
          signal: call.signal,
          progress: (update) => void call.progress(update as unknown as Record<string, unknown>),
          ...(call.door === "rpc" ? { caller: "rpc" as const } : {}),
        })
        // A read with a destination is an export and changes nothing; sharing or administering changes access, not
        // the source's content. Only a write, send or delete can change a declared source.
        const changes = category === "write" || category === "send" || category === "delete" ? capabilitiesOf(answer.operation) : []
        for (const capability of changes) {
          await call.bus.emit("changed", { capability, account: call.account, reason: "write" })
        }
        return {
          ok: true as const,
          category: answer.category,
          operation: answer.operation,
          result: answer.result,
          trust: "untrusted" as const,
          ...(answer.file === undefined ? {} : { file: answer.file }),
          ...(answer.cleanupDegraded === undefined ? {} : { cleanupDegraded: answer.cleanupDegraded }),
        }
      } catch (error) {
        return throwRefusal(error, category)
      }
    },
  }
}
