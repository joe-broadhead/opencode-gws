# AGENTS.md

`@we-the-rebel-alliance/gws-plugin` is an unofficial OpenCode plugin for Google Workspace, id
`google-workspace.gws`. It is a manifest-driven, security-critical adapter around Google's `gws` CLI, pinned at
0.22.5: typed tools, plan then commit for every change, one OpenCode sign-in per account, `/gws-status`,
`/gws-doctor`, and one TUI status dialog. Layout and layers: [docs/architecture.md](docs/architecture.md). Setup and
the check: [CONTRIBUTING.md](CONTRIBUTING.md).

The full plugin standard (fixed-context budget, docs, skills, release) lives in `plugin-contract`'s
`docs/plugin-standard.md`; this file covers what is specific to gws while the repository is brought to it.

## Rules

- Greenfield: no legacy, shim, migration, alias or dual path, and nothing dead (code, exports, dependencies, docs,
  tests, fixtures). Delete rather than deprecate. No process or evidence artifacts in the repository.
- Never commit tokens, client secrets, personal data or absolute local paths. No Google OAuth client ships, not even
  a placeholder: Google's OAuth policy forbids one in public code. Clients come from `oauthClient` or the form.
- Public OpenCode 2.4.1 plugin API only. `opencode.host` is exactly `>=2.4.1 <2.5.0`; setup refuses any other host with
  `HOST_UNTESTED` unless `allowUntestedHost` is set. Setup makes no network calls.
- `ctx.storage` is shared by every project and is not secret-safe. Credentials live only in OpenCode's credential
  store.
- Pass each tool's `signal` into cancellable work; clean up timers and processes.

## Forbidden

`test/architecture.test.ts` and `test/bundle.test.ts` fail on these:

- any `supports*` capability marker;
- tool `options.mcp`, or MCP config `capabilities` or `responsePolicy`;
- the deprecated `ctx.generate.text`;
- `ctx.experimental.artifact`;
- `ui.slot` (no footer, sidebar or other always-visible surface);
- importing `@opencode/ai`, any `@opencode-ai/*` (V1) package, or a private host package (`@opencode/core`,
  `@opencode/server`);
- bundling `effect`, `@opencode/plugin`, OpenTUI or Solid into `dist`;
- install lifecycle scripts.

Also never: imported OAuth grants, credentials from `gws auth login`, or a `PATH` lookup for `gws`.

## Permissions and plan-then-commit

- Setup inserts the block from `defaultRules(access)` (`src/host/agents.ts`, from the lists in `src/domain/access.ts`)
  into every agent through `ctx.agent.transform`, right after its base `* * allow`: the `gws.*` namespace, then the
  six reads (`status`, `catalog`, `schema`, `read`, `plan`, `events_list`) and the source reads (`probe`,
  `calendar_today`, `images_read`, `sheets_read`), then the six commits. `access` is `"all"` (the default), so every
  rule allows; `"ask-changes"` asks for the commits and `"read-only"` denies them.
- A commit always needs a `planId` from `plan`, bound to the session, agent and account. The default allow is a
  permission default, not a shortcut past the plan.
- The six commit tools stay one per class (`write`, `send`, `share`, `delete`, `export`, `admin`): each method has one
  class, and access is decided per class. Never merge them into one commit tool.
- The last matching rule wins, so user rules and saved Always override the block, and a stricter agent is never
  weakened.
- The tools RPC's methods are the six read tools and the source contract's four reads. `rpcCommits`, off by default,
  makes the six commits methods too, for a host that confirms each change itself; an `ask` or a `deny` is refused.
- Plugin policy is deny-only content constraints plus the admin gate. `deploy` and `watch` are never committable.
- Recipient rules fail closed (`src/domain/recipients.ts`): a send or share whose recipients cannot all be determined
  is refused when a rule limits recipients.

## Security

- With no `accounts` option, the `default` account enables every manifest service at Read and write except the
  domain-wide-delegation services (Keep), `admin-reports` (it needs an admin) and `modelarmor` (nothing runs). No
  access level requests an app-only or a delegation scope (`src/domain/restricted.ts`).
- Every change is a `gws --dry-run` plan, committed only by its category's commit tool with `{ planId }`. The RPC, TUI
  and commands never approve or commit, except the tools RPC's commit methods, which exist only when `rpcCommits` is
  on.
- Every call reads a sign-in with `readSignIn` (no client needed: a host's copy for an agent has no client secret);
  only a renewal and a new sign-in's reuse of the previous client use `renewableSignIn`. `refreshGoogle` refuses
  `jelly-host-owns-refresh` first, with no network call.
- Only `src/process/**` spawns `gws`, with an argv array and `shell: false`.
- Never log or preview bodies, tokens, credentials or file contents. Workspace content is untrusted data.
- Do not weaken a security test to get a green run.

## Tools, errors, skills

- `package.json` `sources` declares the plugin's sources under the source contract
  (`@we-the-rebel-alliance/source-contract`, pinned as a devDependency and bundled into `dist/index.js`):
  `gws.gmail` and `gws.calendar` (`events_list`), `gws.calendar.today`, `gws.image` and `gws.sheets` (snapshots), with
  `probe`. `gws.sheets` alone is `private: false`; this is not an account delegation or a sharing grant. The page,
  event, screening, cursor and the tools RPC transport are the package's; never copy them back.
  `test/source-conformance.test.ts` runs the contract's conformance kit over the real methods against the fake gws and
  fails on any difference. Change a declaration and its code together.
- `manifest/generated.json` is the coverage contract. Regenerate it with `npm run manifest`; never hand-edit it or any
  other generated file.
- Tool schemas live in `src/domain/contract.ts` (Zod). The six commit tools are direct tools (`codemode: false`).
- Errors read `CODE: What happened. Next step: What to do.` One `ErrorCode` table feeds the runtime, the audit and the
  Errors section of `docs/configuration.md`.
- Two skills, with real tool and parameter names; each SKILL.md's frontmatter is the one place its description lives.
  Their descriptions and the namespace line stay within the fixed-context budget (400 characters for the namespace,
  300 for each description). Nothing the model sees contains test status or internal jargon.

## Packaging

- JavaScript only: `dist/` holds exactly `index.js` and `tui.js`, each one self-contained esbuild bundle with our code
  and the RPC contract inlined. The contract is plain JSON Schema; `zod` (import it as `import * as z from "zod"`) is
  for tool schemas and lands in `index.js` only. No chunks, no relative imports, no runtime dependencies, no peers, no
  `.d.ts`. The version comes from `package.json` at build time.
- `files` is a whitelist. The package carries no gws binary: the plugin uses its pinned executable from
  `manifest/native.json` (checked against `native/provenance.json`), or an explicit `binary.path`.
- Releases come only from `.github/workflows/release.yml` ("Releasing" in [CONTRIBUTING.md](CONTRIBUTING.md)). Never
  push a tag or a `release/*` branch, and never commit, tag or publish a release by hand. Agents never approve a
  release and never bypass a ruleset or the `release` environment.
- Commits are authored by the repository's configured automation identity. Never commit or tag with a personal or
  work address, or with a local hostname.

## Tests

`npm run check` runs lint, typecheck (`src` and the whole test tree), build, unit tests, the release kit's tests
(`scripts/release-kit.test.mjs`), the embedded-host suite, the pack test on stock OpenCode 2.4.1
(`TESTED_HOSTS` in `src/domain/host.ts`, the one list), the generated-file check and the TUI render. Tests never need
a live Google account; a live check needs the owner's approval for each run.
