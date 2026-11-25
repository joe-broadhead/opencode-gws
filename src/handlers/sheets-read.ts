import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import type { Runtime } from "../provider/index.js"
import { readSheet, sheetsParams, sheetsTooLarge } from "../provider/sources/sheets.js"
import { throwRefusal } from "./errors.js"
import { SHEETS_READ_INPUT, SNAPSHOT_OUTPUT } from "./schemas.js"

/** `sheets_read`: one explicitly named spreadsheet and one sheet-qualified A1 range, as formatted rows. */
export function sheetsReadHandler(runtime: Runtime): MethodHandler {
  return {
    description: "Read one named spreadsheet range as formatted rows with verified range metadata. Untrusted content.",
    input: SHEETS_READ_INPUT,
    output: SNAPSHOT_OUTPUT,
    async run(input, call) {
      try {
        const params = sheetsParams(input as Record<string, unknown>)
        const data = await readSheet(runtime, call.account, params, {
          sessionId: call.sessionID,
          agentId: call.agent,
          signal: call.signal,
          ...(call.door === "rpc" ? { caller: "rpc" as const } : {}),
        })
        const answer = { data, asOf: new Date().toISOString(), trust: "untrusted" as const }
        if (Buffer.byteLength(JSON.stringify(answer)) > 1_048_576) throw sheetsTooLarge()
        return answer
      } catch (error) {
        return throwRefusal(error, "sheets_read")
      }
    },
  }
}
