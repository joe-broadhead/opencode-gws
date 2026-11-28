/**
 * Where Google's Gmail MCP server covers an operation the plugin also has, and the tool that serves it.
 *
 * The Gmail MCP server (https://gmailmcp.googleapis.com/mcp/v1, checked 28 November 2026) exposes a curated set of
 * mailbox tools. Those operations are not the plugin's own tools any more: `read`, `plan_send`, `plan_write` and
 * `plan_delete` refuse them and name the MCP tool instead, and `capabilities.methods` declares that tool as `mcp:<tool>`.
 *
 * The map is the one place the two surfaces meet. An operation that is not here stays the plugin's own, either because
 * the server has no tool for it (attachments, history, settings, permanent delete, export) or because it belongs to
 * another Google service.
 */

/** One covered operation: the server's tools that serve it, the first being the one to name in a next step. */
export interface GmailMcpCoverage {
  readonly tools: readonly string[]
}

/**
 * Every Gmail operation Google's Gmail MCP server covers. The values are the server's tool names, exactly as its
 * `tools/list` returns them.
 */
export const GMAIL_MCP_COVERAGE: Readonly<Record<string, GmailMcpCoverage>> = {
  "gmail.forward": { tools: ["forward"] },
  "gmail.read": { tools: ["get_message", "get_thread"] },
  "gmail.reply": { tools: ["reply"] },
  "gmail.reply-all": { tools: ["reply"] },
  "gmail.send": { tools: ["send_message"] },
  "gmail.triage": { tools: ["search_threads"] },
  "gmail.users.drafts.create": { tools: ["create_draft"] },
  "gmail.users.drafts.get": { tools: ["get_draft"] },
  "gmail.users.drafts.list": { tools: ["list_drafts"] },
  "gmail.users.drafts.send": { tools: ["send_message"] },
  "gmail.users.drafts.update": { tools: ["update_draft"] },
  "gmail.users.labels.create": { tools: ["create_label"] },
  "gmail.users.labels.list": { tools: ["list_labels"] },
  "gmail.users.labels.patch": { tools: ["update_label"] },
  "gmail.users.labels.update": { tools: ["update_label"] },
  "gmail.users.messages.batchModify": { tools: ["update_message_labels", "label_message", "unlabel_message", "mark_message_spam", "unmark_message_spam"] },
  "gmail.users.messages.get": { tools: ["get_message"] },
  "gmail.users.messages.list": { tools: ["search_threads"] },
  "gmail.users.messages.modify": { tools: ["update_message_labels", "label_message", "unlabel_message", "mark_message_spam", "unmark_message_spam"] },
  "gmail.users.messages.send": { tools: ["send_message"] },
  "gmail.users.messages.trash": { tools: ["trash_message", "apply_sensitive_message_label"] },
  "gmail.users.messages.untrash": { tools: ["untrash_message"] },
  "gmail.users.settings.filters.create": { tools: ["create_filter"] },
  "gmail.users.settings.filters.list": { tools: ["list_filters"] },
  "gmail.users.threads.get": { tools: ["get_thread"] },
  "gmail.users.threads.list": { tools: ["search_threads"] },
  "gmail.users.threads.modify": { tools: ["label_thread", "unlabel_thread", "mark_thread_spam", "unmark_thread_spam"] },
  "gmail.users.threads.trash": { tools: ["trash_thread", "apply_sensitive_thread_label"] },
  "gmail.users.threads.untrash": { tools: ["untrash_thread"] },
}

/** The coverage of `operation`, or undefined when the plugin still owns it. */
export function gmailMcpCoverage(operation: string): GmailMcpCoverage | undefined {
  return GMAIL_MCP_COVERAGE[operation]
}

/** The operation ids Google's Gmail MCP server covers, in the order this module names them. */
export function gmailMcpOperations(): readonly string[] {
  return Object.keys(GMAIL_MCP_COVERAGE)
}

/** One tool's id for an account alias's server, as OpenCode names it: `<server>_<tool>`. */
export function gmailMcpToolId(server: string, tool: string): string {
  return `${server}_${tool}`
}

/**
 * The refusal's next step: the Gmail server's tool ids for one covered operation, or undefined when the operation is
 * not covered. The caller prefixes the contract's code and the operation.
 */
export function gmailMcpNextStep(operation: string, server: string): string | undefined {
  const coverage = gmailMcpCoverage(operation)
  if (coverage === undefined) return undefined
  const ids = coverage.tools.map((tool) => `\`${gmailMcpToolId(server, tool)}\``)
  const named = ids.length === 1 ? ids[0]! : `${ids.slice(0, -1).join(", ")} or ${ids.at(-1)}`
  return `Call ${named} instead; Google's Gmail MCP server serves it, and asks before a change.`
}
