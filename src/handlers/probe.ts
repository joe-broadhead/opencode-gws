import { probeResult } from "@we-the-rebel-alliance/plugin-contract/events"
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { GwsError } from "../provider/domain/errors.js"
import { commandIndex } from "../provider/domain/manifest.js"
import type { RuntimeStatus } from "../provider/domain/status.js"
import { throwRefusal } from "./errors.js"
import { PROBE_INPUT, PROBE_OUTPUT } from "./schemas.js"

/** The source names probe knows, the read each would use, and the scopes it reports. */
const PROBED: Readonly<Record<string, { readonly operation: string; readonly scopes: RegExp }>> = {
  gmail: { operation: "gmail.users.getProfile", scopes: /^https:\/\/(?:mail\.google\.com\/|www\.googleapis\.com\/auth\/gmail\.)/ },
  calendar: { operation: "calendar.events.list", scopes: /^https:\/\/www\.googleapis\.com\/auth\/calendar(?:\.|$)/ },
  "calendar-today": { operation: "calendar.events.list", scopes: /^https:\/\/www\.googleapis\.com\/auth\/calendar(?:\.|$)/ },
  image: { operation: "drive.files.get", scopes: /^https:\/\/www\.googleapis\.com\/auth\/drive(?:\.|$)/ },
  sheets: { operation: "sheets.spreadsheets.values.get", scopes: /^https:\/\/www\.googleapis\.com\/auth\/spreadsheets(?:\.|$)/ },
}

/**
 * `probe` (contract §11): whose the account is, from its verified sign-in, and the scopes Google granted for the
 * source. It calls no Google API and reads no content.
 */
export function probeHandler(runtimeStatus: () => Promise<RuntimeStatus>): MethodHandler {
  return {
    description: "Read the signed-in owner and granted scopes for an account, without reading any content.",
    input: PROBE_INPUT,
    output: PROBE_OUTPUT,
    async run(input, call) {
      const source = typeof input["source"] === "string" ? input["source"] : "gmail"
      const probed = PROBED[source]
      if (probed === undefined) {
        throwRefusal(
          new GwsError("SOURCE_UNKNOWN", `the source '${source.slice(0, 64)}' is not one this plugin declares`, { next: `Probe one of ${Object.keys(PROBED).join(", ")}.` }),
          "probe",
        )
      }
      const status = await runtimeStatus()
      const account = status.accounts.find((entry) => entry.alias === call.account)
      if (account === undefined || !account.connected || account.email === undefined) {
        throwRefusal(
          new GwsError("AUTH_REQUIRED", `the account '${call.account}' has no verified sign-in email for the probe to name`, {
            next: "Sign the account in through /connect again, and approve every scope Google lists.",
          }),
          "probe",
        )
      }
      const operationScopes = commandIndex().methods.get(probed.operation)?.scopes ?? []
      const scopes = [...new Set((account.grantedScopes ?? []).filter((scope) => probed.scopes.test(scope) || operationScopes.includes(scope)))].slice(0, 64)
      return probeResult({ source, account: call.account, owner: { id: `mailto:${account.email}`, label: account.email } }, { scopes })
    },
  }
}
