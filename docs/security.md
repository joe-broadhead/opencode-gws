# Security

## What leaves the machine

Only calls the user makes: through OpenCode's MCP client to Google's Gmail MCP server, and through the pinned `gws`
executable to Google's API endpoints and Google's image servers. Setup registers the server and makes no network call
of its own and downloads nothing: when the native manifest is present, the binary is fetched on the first call that
needs it, under the access rules. The `v0.0.0` package carries that manifest, and its release assets carry the
verified gzips. The plugin sends no telemetry.

## Scopes

Each account requests the scopes its enabled services need, at the access level chosen at sign-in: read-only, or read
and write. The sign-in form shows the exact scope list before the browser opens. Identity scopes (`openid`, `email`,
`profile`) are requested with every sign-in so a probe and status can name the owner. Domain-wide delegation is never
requested; a service that needs it is reported, not reached. The plugin ships no OAuth client; the user's own client is
used, marked for an AI agent, and the Gmail MCP service and API are enabled in its project, as Google's
[setup guide](https://developers.google.com/workspace/guides/configure-mcp-servers) says.

## Google's Gmail MCP server

An interactive account's Gmail tools are Google's, reached by OpenCode's MCP client with the same grant the plugin's
own reads use. Google's server asks for confirmation before a sensitive action with MCP form elicitation, and the
plugin's own rules add the Gmail tool's class: a send or a delete asks under every access level, and `read-only`
denies it. A headless profile has no MCP sign-in, so it keeps the plugin's own Gmail operations and the plan/commit
flow below.

## Secrets

- Credentials live only in OpenCode's credential store. The plugin reads the access token only to put it in the `gws`
  child's environment; OpenCode's MCP client reads the same grant for the Gmail server's tools.
- No token, client secret, body, file content or URL query string reaches a log, status, an error or the audit. A
  reason is one line, redacted and cut to 160 characters.
- The synthetic fixture is redacted with `plugin-kit record`, which removes credentials, emails, phone numbers, home
  directories and sensitive query values before the file is committed.

## The plan/commit flow

1. The plan method for the change's class (`plan_write`, `plan_send`, `plan_share`, `plan_delete`, `plan_export` or
   `plan_admin`) resolves the operation, applies the policy, stages any upload, runs `gws --dry-run`, and stores the exact
   commit argv with the plan. It writes nothing.
2. The preview shows the redacted command, the recipients a send or share reaches, the destination of an export, and
   Google's dry-run answer. The contract mints a single-use `planId` and stores the answer.
3. The commit tool of the plan's class takes only `{ planId }`. The register runs it as the plan's account, checks its
   permission gate, and refuses:
   - a second commit (`PLAN_USED`),
   - another class's tool or an expired plan (`PLAN_INVALID`),
   - a recipient that changed after the preview (the commit re-reads them and refuses an addition).
4. In an agent session, a non-read call asks through OpenCode's permission rules. Over RPC, an allow rule is not a
   confirmation: the call needs an answered ask. A saved "Always allow" from a tool call never confirms an RPC write.

Google's Gmail MCP tools are not in this flow: Google's server owns the action, asks through form elicitation, and the
plugin's manifest gives each tool its class and `effect: "ask"` so the plugin's access level still decides. A Gmail
operation the server covers is refused by the plugin's own read and plans, with the tool that replaces it.

## Untrusted content

Every answer is marked `trust: "untrusted"`. Workspace text is data: the plugin never follows it, never echoes it into
status, and never uses it to choose a tool or a recipient. An event holding a secret is refused (`refused[]`), and an
instruction-shaped message from someone else may be refused.

## Access

`access` is the ceiling: `all`, `ask-changes` or `read-only`. The plugin's methods table is the class of every call;
`read` runs at every level, every other class is off under `read-only`. A method's `effect` can narrow the level, never
widen it. The rules are inserted after each agent's base allow, and status names any agent whose later rules widen them.
