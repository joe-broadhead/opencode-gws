import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import type { Runtime } from "../provider/index.js"
import { throwRefusal } from "./errors.js"
import { SCHEMA_INPUT, SCHEMA_OUTPUT } from "./schemas.js"

/** `schema`: one operation's parameters and request body, or a helper's flags, from the pinned catalog. */
export function schemaHandler(runtime: Runtime): MethodHandler {
  return {
    description: "Show one operation's parameters, scopes and request body, or a helper's input flags, before a read or plan.",
    input: SCHEMA_INPUT,
    output: SCHEMA_OUTPUT,
    async run(input, call) {
      const operation = input["operation"] as string
      try {
        const target = runtime.inspectSchema(call.account, operation)
        return await runtime.describe(target, {
          signal: call.signal,
          progress: (update) => void call.progress(update as unknown as Record<string, unknown>),
        })
      } catch (error) {
        return throwRefusal(error, "schema")
      }
    },
  }
}
