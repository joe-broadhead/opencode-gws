# Security

## What leaves the machine

Only calls the user makes, through the pinned `gws` executable, to Google's API endpoints and Google's image servers.
Setup itself makes no network call and downloads nothing: the binary is fetched on the first call that needs it, under
the access rules. The plugin sends no telemetry.

## Scopes

Each account requests the scopes its enabled services need, at the access level chosen at sign-in: read-only, or read
and write. The sign-in form shows the exact scope list before the browser opens. Identity scopes (`openid`, `email`,
`profile`) are requested with every sign-in so a probe and status can name the owner. Domain-wide delegation is never
requested; a service that needs it is reported, not reached. The plugin ships no OAuth client; the user's own client is
used.

## Secrets

- Credentials live only in OpenCode's credential store. The access token exists only in the `gws` child's environment.
- No token, client secret, body, file content or URL query string reaches a log, status, an error or the audit. A
  reason is one line, redacted and cut to 160 characters.
- Fixtures are recorded with `plugin-kit record`, which redacts credentials, emails, phone numbers, home directories and
  sensitive query values before the file is committed.

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
   - a recipient that changed after the preview (the commit re-reads them and refuses an addition),
   - an upload whose bytes changed (`UPLOAD_CHANGED`).
4. In an agent session, a non-read call asks through OpenCode's permission rules. Over RPC, an allow rule is not a
   confirmation: the call needs an answered ask or a host-signed action grant. A saved "Always allow" from a tool call
   never confirms an RPC write.

## Untrusted content

Every answer is marked `trust: "untrusted"`. Workspace text is data: the plugin never follows it, never echoes it into
status, and never uses it to choose a tool or a recipient. An event holding a secret is refused (`refused[]`), and an
instruction-shaped message from someone else may be refused.

## Access

`access` is the ceiling: `all`, `ask-changes` or `read-only`. The plugin's methods table is the class of every call;
`read` runs at every level, every other class is off under `read-only`. A method's `effect` can narrow the level, never
widen it. The rules are inserted after each agent's base allow, and status names any agent whose later rules widen them.
