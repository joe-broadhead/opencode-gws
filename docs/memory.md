# Sources

The plugin declares its sources at the top level of `package.json` (`sources`, contract version 1): `gws.gmail` and
`gws.calendar`. A project (Memory, jelly, Artifacts) reads that declaration from the installed package, asks the person
once per source, account and scope, and reads through the source contract. The plugin is a read-only connector: every
write stays its own plan-then-commit tools.

| Source | Reads | Tool | Scope | Operations |
| --- | --- | --- | --- | --- |
| `gws.gmail` | messages | `events_list` | none | `gmail.users.getProfile`, `gmail.users.history.list`, `gmail.users.messages.list`, `gmail.users.messages.get` |
| `gws.calendar` | meetings | `events_list` | `calendars` (one, `primary` by default) | `calendar.calendarList.get`, `calendar.events.list` |

`probe` answers a source's account and owner and asserts `gws.events_list` only. Every page names its contract source id
(`gws.gmail`), the account and owner, `refused[]` (final drops, a secret-shaped item among them), `failed[]` (retryable
drops; any entry holds the cursor back), and `gap: { reason: "expired" | "window-truncated", since }` when history was
lost. A foreign cursor is `CURSOR_INVALID`. `events_list` with `limit: 0` is a deprecated alias for `probe`.

The conformance kit is the source-contract package's, vendored under `vendor/` at commit `3fe6255` and run by
`test/source-conformance.test.ts`. To pause collection, pause the binding in the project or deny `gws.events_list` in
OpenCode; uninstall the plugin to stop entirely.
