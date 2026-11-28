import { accountName } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { GwsError } from "../provider/domain/errors.js"
import { gmailMcpNextStep } from "../provider/domain/mcp.js"
import type { Runtime } from "../provider/index.js"

/**
 * The Gmail operations Google's Gmail MCP server serves are not this plugin's tools any more. An interactive account
 * signs in once, the server's tools are the Gmail surface, and a call that still names a covered operation is refused
 * with the tool that replaces it. A headless profile keeps the plugin's own copy: it has no MCP sign-in, and its gws
 * calls must keep working.
 */
export function refuseGmailMcp(runtime: Runtime, operation: string, account: string, action: string): void {
  if (!runtime.gmailOnMcp(account)) return
  // An export writes the answer to a file and an admin plan reads it for an audit: Google's server offers neither act.
  if (action === "plan_export" || action === "plan_admin") return
  const next = gmailMcpNextStep(operation, accountName("gws", account))
  if (next === undefined) return
  throw new GwsError("MCP_HANDOFF", `${operation} is served by Google's Gmail MCP server, and ${action} no longer runs it`, { next })
}
