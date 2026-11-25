# Architecture

## Layers

```
src/index.ts        one register call: host gate, skills, provider, integrations, handlers
src/accounts.ts     integration mechanism: auth methods, token, connection, auth-state reports
src/skills.ts       registers every skills/<id>/SKILL.md through ctx.skill.transform
src/handlers/       one handler per method; schemas and error mapping
src/provider/       the gws client and the operation pipeline
```

The handler layer knows the contract; it never spawns a process or reads a credential. The provider layer knows gws and
Google; it never registers a tool, an RPC id or a permission rule. `src/provider/domain/` holds the catalog, policy,
recipient rules, plans, configuration, audit and error table; `src/provider/process/` holds the binary resolution, the
child process, staging and the image fetch; `src/provider/sources/` holds the events and snapshot readers.

## The provider client

- **Binary.** `src/provider/process/binary.ts` resolves one pinned gws 0.22.5 executable from `native/provenance.json`
  and the release manifest `manifest/native.json`, checks its SHA-256 and refuses a writable or project-local copy. A
  call may download it only when the access rules allow the first-use write. The `v0.0.0` package does not commit
  `manifest/native.json` yet, so native calls answer `GWS_UNAVAILABLE` until the lead adds the manifest and gzips, or
  `binary.path` names a system copy.
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

The plugin uses `@opencode/plugin` 2.4.1 only: `ctx.integration` for the sign-in methods and credentials,
`ctx.options`, `ctx.app.version`, `ctx.location.directory`, `ctx.skill.transform` for the packaged skills, and
`ctx.agent.list()` through the contract's `unguardedAgents`. Every door (agent tool, Code Mode, RPC) and every
permission rule comes from the contract's `register`; the plugin writes none of them.
