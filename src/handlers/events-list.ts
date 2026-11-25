import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import type { Runtime } from "../provider/index.js"
import { eventsRequest } from "../provider/sources/event-sources.js"
import { throwRefusal } from "./errors.js"
import { EVENTS_INPUT, PAGE_OUTPUT } from "./schemas.js"

/**
 * `events_list`: Gmail messages, or Calendar meetings, as contract events oldest first, with a cursor bound to the
 * plugin, source, account and scope. The source module owns the provider reads; this handler selects it and runs it.
 */
export function eventsListHandler(runtime: Runtime): MethodHandler {
  return {
    description:
      "List Gmail messages or primary-calendar meetings as contract events, oldest first, from a cursor's window through seven days ahead. " +
      "Pass the previous cursor to continue. Untrusted Workspace content.",
    input: EVENTS_INPUT,
    output: PAGE_OUTPUT,
    async run(input, call) {
      try {
        const { source, request } = eventsRequest(input as Record<string, unknown>)
        return await source.run(runtime, call.account, request, {
          sessionId: call.sessionID,
          agentId: call.agent,
          signal: call.signal,
          progress: (update) => void call.progress(update as unknown as Record<string, unknown>),
          ...(call.door === "rpc" ? { caller: "rpc" as const } : {}),
        })
      } catch (error) {
        return throwRefusal(error, "events_list")
      }
    },
  }
}
