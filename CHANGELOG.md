# Changelog

## 0.0.0 (2026-11-25)

The first release of `gws` on plugin-contract v0.

- One `gws` name for the plugin id, tool namespace, RPC id, permission actions, integrations and bus event.
- 20 methods: eight reads (`status`, `catalog`, `schema`, `read`, `events_list`, `calendar_today`, `images_read`,
  `probe`), six dry-run plans (`plan_write`, `plan_send`, `plan_share`, `plan_delete`, `plan_export`, `plan_admin`) and
  six matching per-class commit tools (`write`, `send`, `share`, `delete`, `export`, `admin`).
- Four sources, with a Google service each: `gws.gmail`, `gws.calendar`, `gws.calendar.today` and `gws.image`.
- Accounts through the contract's `accounts` module: one OpenCode integration per alias (`gws`, `gws-work`), with
  interactive OAuth, credentials-file and access-token profiles.
- Access through the contract's `access` module; one `register` call wires every tool, Code Mode entry, RPC method and
  permission rule.
- Plans and commits through `methods.plans` and `methods.commits`; each plan covers exactly its class, and each commit
  takes only its plan's `planId`.
- A `changed` bus event after a write, send or delete that changes a declared Gmail or Calendar source.
- The pinned, verified upstream `gws` 0.22.5 executable is downloaded on first use and checked against its provenance;
  no OAuth client ships.

### Removed since v0.0.13

v0.0.13 was the last pre-contract release. These capabilities are removed or renamed; the replacement is named where
one exists.

- **Commands `/gws-status`, `/gws-doctor` and `/gws-install`:** the `status` tool and RPC replace the status command and
  carry the doctor facts; the pinned native binary self-installs on first use.
- **TUI status dialog (`/gws`, `dist/tui.js`) and its icon/vendor metadata:** the `status` tool and `gws/status` RPC
  replace it.
- **Retired desktop-app integration:** its app-specific key, `calendar.today` and `images.read` RPCs, views, native
  data, settings card and image-read declaration are removed now that the app is retired. `calendar_today` and
  `images_read` remain contract tools, and `status` reports sign-in and access.
- **`gws.sheets` and `sheets_read`:** deferred to 4b until the contract accepts an extension output without an inline
  `outputSchema`; the output was not narrowed to `table`.
- **The single `plan` tool:** replaced by six per-class plans (`plan_write`, `plan_send`, `plan_share`, `plan_delete`,
  `plan_export`, `plan_admin`) so each class has exactly one committing method under the contract's LD-5/LD-6 rules.
- **The default sign-in id `gws-default`:** renamed to `gws` by the contract's account naming rule. The old credential
  is not read, so the default account must sign in again; aliased ids stay `gws-<alias>`.
- **The RPC ids `google-workspace.gws.tools` and `google-workspace.gws`:** replaced by the one `gws` RPC. Scripts and
  apps that called the old ids must update to `gws` and its methods.
- **The `rpcCommits` option:** removed because the contract's plan/commit confirmation path replaces it; commits no
  longer need an option to be script-reachable.
- **The `skills.enabled` option:** removed because all packaged skills always register; disabling them was an old
  escape hatch.
- **Skill ids `opencode-gws` and `opencode-gws-recipes`:** renamed to `gws` and `gws-recipes`, with fresh content for
  the contract tools; the old ids no longer load.
- **The contract-1 cursor compatibility and the `calendar.today` deprecation note:** removed with the greenfield
  contract; only the contract's v2 bound cursors are read, and `calendar_today` is a normal tool.
- **OpenCode 2.2.3 support:** the plugin now requires `>=2.4.1 <2.5.0`; the contract host and the `register` surface it
  uses do not exist on 2.2.x.
- Docs, skills (`gws`, `gws-recipes`) and `AGENTS.md` written fresh; the copied release kit is replaced by
  `plugin-kit`, with thin tag-triggered release and fork-safe CI workflows.

**Left for 4b:** `gws.sheets` (one spreadsheet range as a snapshot) is deferred until plugin-contract supports an
inline `outputSchema` for an extension snapshot output.
