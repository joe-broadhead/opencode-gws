# Contributing

## Setup

Node 24 or later. The TUI render check needs Bun 1.4.4 or later, the version CI runs. `gws` is fetched by the script below; do not install a different version on `PATH` and expect the plugin to use it.

```bash
npm ci
npm run fetch:gws
npm run check
```

`npm run build` runs `scripts/bundle.mjs`, which writes exactly `dist/index.js` and `dist/tui.js`, each a self-contained esbuild bundle. To load the checkout in OpenCode, build it and point a plugin entry at its directory:

```bash
npm run build
```

```jsonc
{ "plugins": [{ "package": "<path-to-checkout>" }] }
```

`npm run check` is the local gate: lint, typecheck, build, unit tests, the release kit's tests, the host suite, the pack-install check, the generated-file check, and the TUI render. Run it before a change is reviewed.

The host suite embeds `@opencode/sdk` 2.2.3. It needs Node 24. `HOST_SDK_DIR`, when set, is an extra embedded SDK directory for that pack check (for example a 2.2.4 SDK kept outside the lockfile).

The pack check loads the installed tarball in each tested stock OpenCode: 2.2.3, 2.2.4, 2.2.5 and 2.2.6, the one list `TESTED_HOSTS` in `src/domain/host.ts`. Set `OPENCODE_BIN_2_2_3`, `OPENCODE_BIN_2_2_4`, `OPENCODE_BIN_2_2_5` and `OPENCODE_BIN_2_2_6` to those binaries to skip the download. When one is unset, the script installs `@opencode/cli` and the current platform package into its temp folder with scripts disabled, once per version. It checks the version each binary reports, which must be inside `opencode.host`, so a slot may hold a newer binary. Do not set `OPENCODE_BIN`. The script ignores it. Each stock load uses its own temp root for `HOME`, the XDG folders, `OPENCODE_TEST_HOME` and `TMPDIR`, starts in that project directory, and refuses to continue unless every `opencode debug paths` entry is inside the root.

## Generated files

Do not edit these by hand:

```bash
npm run manifest
npm run docs:coverage
npm run drift
```

`npm run manifest` regenerates `manifest/generated.json` from the pinned `gws`. `npm run docs:coverage` regenerates `docs/coverage.md`, the Errors section of `docs/configuration.md`, and the scope table in `docs/auth.md`. `npm run generated:check` fails if those drifted. `npm run drift` compares the manifest with the pinned `gws` and warns; it does not stop a call.

A new upstream release: record its archive URL and SHA-256 (checked against the release's own `.sha256` file), and the executable's size and SHA-256, in `native/provenance.json`; mirror the executable's SHA-256 in `src/domain/backend.ts`. Then `npm run fetch:gws` refuses any archive or executable that does not match the pins.

An example config is in [examples/opencode.jsonc](examples/opencode.jsonc). The source layout is in [docs/architecture.md](docs/architecture.md#source-layout).

## Behaviour

- Tool schemas: `src/domain/contract.ts`
- Tool adapters: `src/host/tools.ts`
- Options: `src/domain/config.ts`
- Ask rules: `src/host/agents.ts`
- Policy: `src/domain/policy.ts`
- Scope sets: `src/domain/scopes.ts`
- Errors: `src/domain/errors.ts`
- Skills: `skills/*/SKILL.md` and `src/host/skills.ts`

Add a focused test under `test/`. Keep it independent of a live Google account.

A public tool or config change needs a test and a docs update.

## Release

### Releasing

Each release is the GitHub tag `v<version>`, where `<version>` is the `version` in `package.json`, and users install from
that tag. The release is one commit on top of a `master` head that CI passed, and the tag points at it.

While changes land, their notes go under `## [Unreleased]` at the top of `CHANGELOG.md`. Each earlier GitHub release is
a `## [x.y.z] - YYYY-MM-DD` heading below it, newest first, and the npm history stays last, under
`## Earlier releases on npm`.

1. On `master`, set `version` in `package.json` to the new version, and change every install spec in the README,
   `CONTRIBUTING.md` and `docs/` to `#v<version>` (`test/docs.test.ts` fails until they match). Then run
   `node scripts/changelog.mjs release`: it turns `## [Unreleased]` into `## [<version>] - <today>`, above the earlier
   releases, and refuses a CHANGELOG it cannot shape. Run `npm run check`.
2. Push that commit to `master`, and wait for CI to pass on it.
3. Run the `native` workflow on that commit. It builds the release files for `v<version>`.
4. In a clean checkout of `master` at that commit, run
   `node scripts/release-commit.mjs --ci-sha <its full sha> --native-run <the native run id>`. It refuses a version that
   is not `x.y.z`, a tag that already exists, and a CHANGELOG whose newest release is not this version. It builds
   `dist/`, removes the lifecycle scripts, copies the native manifest, and creates the signed commit and the signed
   annotated tag `v<version>`. It never pushes; `--dry-run` shows the change first.
5. Push the tag only: `git push origin v<version>`.
6. Approve the run in the `release` environment. The release workflow refuses a tag that is not exactly
   `v<package.json version>`, checks the tag and its commit, installs the tag on each stock OpenCode host (2.2.3 to
   2.2.6), packs it, and creates the GitHub Release with the version's CHANGELOG section as its notes, the tarball, the
   native files and `SHA256SUMS`.

The repository's tag ruleset keeps a pushed `v*` tag from being moved or deleted, so check `--dry-run` before step 5.

The workflow also checks that the release commit is exactly what step 4 writes: its `package.json` is the parent's
without the lifecycle scripts, byte for byte, and `dist/` is a fresh build of the parent. It checks that releases move
forward: the version is newer than every earlier release tag, and the parent is on `master` and descends from the parent
of the release before. It does not require the parent to be `master`'s head when the tag is checked: `master` can move
while the release waits for its approval, and the release job runs the check again, so that rule would refuse a release
that is right. Step 4 checks the head instead, with `--ci-sha`.

The release kit is these files, the same in every plugin: `scripts/release-commit.mjs`, `scripts/check-release-shape.mjs`,
`scripts/changelog.mjs`, `scripts/release-version.mjs`, `scripts/release-pack.mjs`, `scripts/publish-release.mjs`,
`scripts/attach-native.mjs`, `scripts/native-manifest.mjs`, `scripts/tested-hosts.mjs`,
`scripts/check-release-plugin-add.sh`, `scripts/release-kit.test.mjs` and `.github/workflows/release.yml`. Do not re-run
the older `apply-release-kit.mjs`: it writes back the kit that could release only `v0.0.0`.

Each release has its own tag, and a Git install does not update by itself. To move to a newer release, remove the old entry with `opencode plugin remove github:joe-broadhead/opencode-gws#v<old version>`, then add the new tag with `opencode plugin add github:joe-broadhead/opencode-gws#v<version>`.

Or add the plugin to `opencode.json` instead, with the same spec:

```json
{ "plugins": [{ "package": "github:joe-broadhead/opencode-gws#v0.0.0" }] }
```
## Live checks

These need the owner's authorization for that run, on a disposable test account. Do not run them against a personal or production Workspace.

1. Sign in from zero with no plugin options. The form and Google's consent screen show only read scopes plus the identity scopes. `/gws-status` shows `access: read`. A Gmail list read succeeds. A Drive write plan fails with `AUTH_SCOPE_MISSING` and does not start `gws`. After signing in again with Read and write and acknowledging, the same plan can be committed.
2. On that same account, exercise `status`, `catalog`, `schema`, `read`, `plan`, `write`, `send` (to self), `share` then revoke, `delete` of the asset just created, and `export` to a temp path. `admin` stays denied with the default config.
3. Confirm an agent defined only in user config is named by `/gws-status` and the status dialog, and counted by `gws_status`.
