# Accounts

Accounts are held by the **mcp** mechanism: each alias is one OpenCode MCP server at Google's Gmail endpoint, and the
server's integration holds the OAuth grant. The plugin puts its Google sign-in on that integration, so one sign-in
serves the Gmail tools, the plugin's sources and its remaining services. The plugin never holds a token of its own.

<!-- generated:accounts -->
Accounts are held by the **mcp** mechanism: the vendor's MCP server holds them.

| Field | Type | Required |
|---|---|---|
| `mode` | `interactive` \| `credentials_file` \| `access_token` | no |
| `enabledServices` | array | no |
| `domains` | array | no |
| `access` | value | no |
| `scopes` | array | no |
| `oauthClient` | value | no |
| `credentialsFileEnv` | string | no |
| `tokenEnv` | string | no |
<!-- /generated:accounts -->

## Sign in

| Alias | Server |
|---|---|
| `default` | `gws` |
| `work` | `gws-work` |

- In OpenCode, run `/connect` and choose **Google Workspace** (or **Google Workspace (work)**). Paste a Desktop OAuth
  client's ID and secret, choose read-only or read and write, and approve the scopes.
- From a terminal, `opencode auth login gws-work` starts the same flow.
- Google's Gmail MCP server accepts the token only when the OAuth client is marked **Use this client for an
  AI-powered agent** in Google Auth Platform, and the client's project enables `gmailmcp.googleapis.com` with
  `gmail.googleapis.com`. See
  [Configure Google Workspace MCP servers](https://developers.google.com/workspace/guides/configure-mcp-servers).
- The host gives each server a generic OAuth method; the plugin replaces it with the Google form, so the client and the
  scopes are the plugin's.
- A headless profile names `credentialsFileEnv` or `tokenEnv`; the value is read at call time and never stored. It has
  no MCP sign-in, so it keeps the plugin's own Gmail operations, and the Gmail tools ask it to sign in if called.
- One OAuth client may serve every alias; set it once in `oauthClient` or paste it at the first sign-in.

## Choosing an account

Every method declared `accounts: "optional"` takes `account`. With one account it may be left out; with several,
omitting it is `ACCOUNT_REQUIRED`, whose next step lists the aliases. An unknown alias is `ACCOUNT_UNKNOWN`. A commit
takes no account: the register runs it as the account the plan recorded. A Gmail MCP tool carries its account in its
server name (`gws_...` or `gws-work_...`), so it takes no `account` input either.

## Status and probe

`status` lists every alias with `ready`, `needs_sign_in` or `error`, and its owner once a probe has answered. `probe`
returns `{ source, account, owner, scopes? }` from the verified sign-in and reads no content. A sign-in that was revoked
is `NEEDS_SIGN_IN` from the first call that needs it.
