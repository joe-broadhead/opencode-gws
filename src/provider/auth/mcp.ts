/**
 * Google's Gmail MCP server, as OpenCode's MCP client takes it.
 *
 * The server is one per account alias, named by the contract's rule (`gws` for `default`, `gws-<alias>` otherwise).
 * `oauth: {}` asks the host to give it an integration and a sign-in method; `src/accounts.ts` replaces that generic
 * method with the plugin's Google sign-in, so the account signs in once and the plugin's own reads use the same grant.
 *
 * This module is the only place the Gmail MCP URL is written.
 */

/** Google's Gmail MCP server: the streamable HTTP endpoint, with form elicitation for sensitive actions. */
export const GMAIL_MCP_URL = "https://gmailmcp.googleapis.com/mcp/v1"

/** The remote server config for one account's server name. */
export function gmailMcpServer(): Record<string, unknown> {
  return { type: "remote", url: GMAIL_MCP_URL, oauth: {} }
}
