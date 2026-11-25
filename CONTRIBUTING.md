# Contributing

The plugin follows [the plugin standard](https://github.com/we-the-rebel-alliance/plugin-contract/blob/master/docs/plugin-standard.md)
on [plugin-contract v0](https://github.com/we-the-rebel-alliance/plugin-contract).
Read `AGENTS.md` first; it lists the layout, the rules and the contract wiring.

## Change a capability

1. Edit `package.json` `capabilities` (method, source or option) first.
2. Add or change the handler in `src/handlers/`, with the provider call in `src/provider/`.
3. Add unit tests. For a source or an account, record a fixture with `npx plugin-kit record --account <alias>`.
4. A write needs a planning read for its class and the matching commit; each plan covers exactly its own class.
5. Run `npx plugin-kit docs`, then `npm run check`. Both must be green; a skipped gate is a failure.

## Checks

| Command | Runs |
|---|---|
| `npm run check` | fetch the pinned gws, lint, typecheck, bundle, unit, `plugin-kit check`, host, pack, docs drift |
| `npx plugin-kit check` | manifest, methods, accounts, sources, bus, status, T0 and T1 |
| `npx plugin-kit docs --check` | generated sections are current |
| `npm run test:host` | the built bundle on the real OpenCode 2.4.1 host |
| `npm run test:pack` | the packed tarball installs and starts |
| `npm run docs` | regenerates the generated doc sections |
| `npm run test:pack` | the packed tarball installs and starts |

Set `OPENCODE_BIN_2_4_1` to a stock OpenCode 2.4.1 binary to run the pack test against it.

## Fixtures

`fixtures/conformance.json` is the plugin's evidence to the conformance kit. The current file is recorded from the
synthetic accounts and the plugin's own handlers; the conformance kit replays it, so a changed answer fails the gate
instead of drifting. Record from real accounts with `npx plugin-kit record --account <alias>`; the kit redacts
credentials, emails, phone numbers and home directories before it writes.

## Release

The lead cuts releases after a pull request merges. `plugin-kit release <version>` creates the local tag; CI publishes
the GitHub release from it. Never push a tag or publish by hand. The release names the native files explicitly: the
`v<version>` `gws-<target>.gz` assets, `manifest/native.json` and `native/provenance.json`. They are separate from the
package tarball; `manifest/native.json` downloads the gzips, so a directory glob would upload a directory instead of
the named assets.
