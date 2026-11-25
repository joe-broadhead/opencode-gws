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
- The upstream `gws` 0.22.5 provenance is pinned, but v0.0.0 does not package `manifest/native.json` or the
  `gws-<target>.gz` assets; native calls answer `GWS_UNAVAILABLE` until the lead attaches them, or `binary.path` names a
  system copy. No OAuth client ships.
