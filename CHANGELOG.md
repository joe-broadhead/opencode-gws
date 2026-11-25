# Changelog

## [0.0.0]

The first release of `gws` on plugin-contract v0.

- One `gws` name for the plugin id, tool namespace, RPC id, permission actions, integrations and bus event.
- The `capabilities` manifest: 16 methods (10 reads, one each of write, send, share, delete, export and admin), five
  sources with a Google service each, and `changed`.
- Accounts through the contract's `accounts` module: one OpenCode integration per alias (`gws`, `gws-work`), with
  interactive OAuth, credentials-file and access-token profiles. The host-specific refresh sentinel and its fixtures are
  gone.
- Access through the contract's `access` module; one `register` call wires every tool, Code Mode entry, RPC method and
  permission rule.
- Plans and commits through `methods.plans` and `methods.commits`; the six per-class commit tools are unchanged in
  intent, and each takes only its plan's `planId`.
- A `changed` bus event after a commit that changes a declared Gmail, Calendar or Sheets source.
- Docs, skills and `AGENTS.md` written fresh; the copied release kit is replaced by `plugin-kit`, with a thin
  tag-triggered release workflow.
