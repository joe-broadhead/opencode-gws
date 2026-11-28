# Architecture

## Layers

```
src/index.ts        one register call: host gate, skills, provider, MCP server, handlers
src/accounts.ts     the mcp mechanism: one Gmail server per alias, the Google sign-in, token, connection, auth-state
src/skills.ts       registers every skills/<id>/SKILL.md through ctx.skill.transform
src/handlers/       one handler per method; schemas and error mapping
src/provider/       the gws client, Google's Gmail MCP endpoint and the operation pipeline
```

The handler layer knows the contract; it never spawns a process or reads a credential. The provider layer knows gws and
Google; it never registers a tool, an RPC id or a permission rule. `src/provider/domain/` holds the catalog, policy,
recipient rules, plans, configuration, audit, error table and the Gmail operations Google's MCP server covers;
`src/provider/process/` holds the binary resolution, the child process, staging and the image fetch;
`src/provider/sources/` holds the events and snapshot readers.

## Google's Gmail MCP server

`src/provider/auth/mcp.ts` is the only place the Gmail endpoint is named. Setup registers one server per alias through
the contract's `accounts` module, then attaches the plugin's Google sign-in to the integration OpenCode gives it, in
place of the generic OAuth method. The server's tools are the Gmail surface for an interactive account: `read`,
`plan_write`, `plan_send` and `plan_delete` refuse an operation in `src/provider/domain/mcp.ts` and name the tool; the
catalog hides those operations. `plan_export` and `plan_admin` keep them, because an export to a file and an admin
audit are acts the server does not offer. A headless profile keeps the plugin's own Gmail operations, because it has no
MCP sign-in.

The other Google services stay on the pinned gws executable. Google publishes one MCP server per product, and the
contract registers one server per alias; registering nine would leave eight outside the generated permission rules.

## The provider client

- **Binary.** `src/provider/process/binary.ts` resolves one pinned gws 0.22.5 executable from `native/provenance.json`
  and the release manifest `manifest/native.json`, checks its SHA-256 and refuses a writable or project-local copy. A
  call may download it only when the access rules allow the first-use write. The `v0.0.0` package carries `manifest/native.json`, and its release assets carry the verified `gws-<target>.gz` files;
  `binary.path` can name a system copy instead.
- **Command catalog.** `manifest/generated.json` is generated from the pinned gws by `npm run manifest` (cases in
  `scripts/generate-manifest.mjs`). Runtime code resolves every request to a catalog entry before it spawns anything.
- **Process.** `src/provider/process/run.ts` spawns with an argv array and `shell: false`, with a timeout, output caps
  and the call's cancellation signal. Only this directory spawns `gws`.
- **Reads and writes.** `src/provider/operations.ts` is one pipeline: resolve → classify → policy → build → run → parse.
  A read is audited as `operation.read`; a plan runs `--dry-run` and stores the exact commit argv; a commit re-stages
  its files, applies the stored argv, audits the outcome and emits the contract's `changed` nudge.
- **Policy.** Deny-only rules constrain services, categories, operations, recipients, public sharing, file roots and
  page sizes. The admin gate is separate: `admin.enabled`, `admin.allowedServices` and a required reason on every admin
  plan.

## State and caches

- Plans live in memory, bound to the session, agent and account, for `policy.planTtlSeconds` (15 minutes by default).
  A plan commits once; a failed handler uses it up, and a refused permission releases it.
- The account's own address and the calendar day's read are kept in memory for a short time. Nothing else is cached.
- The audit log is one JSON line per call, under the plugin's state directory unless `audit.path` names a file. It
  records codes, accounts, categories, operations and durations, never a body, token or URL query.
- The gws binary and its Discovery cache live under the plugin's cache directory. A headless credentials-file account
  gets its own gws directory there.

## OpenCode APIs

The plugin uses `@opencode/plugin` 2.4.1 only: `ctx.mcp` for the Gmail server per alias, `ctx.integration` for the
sign-in methods, credentials and auth-state reports on each server's integration, `ctx.options`, `ctx.app.version`,
`ctx.location.directory`, `ctx.skill.transform` for the packaged skills, and `ctx.agent.list()` through the contract's
`unguardedAgents`. Every door (agent tool, Code Mode, RPC) and every permission rule comes from the contract's
`register`; the plugin writes none of them. The Gmail MCP tools get their rules from the manifest's `mcp:` rows, which
the contract's access module derives for each alias's server name.
