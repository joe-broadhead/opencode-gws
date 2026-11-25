# Automations

An OpenCode automation reads a source with `tools.gws.events_list`, keeps its cursor in the automation's durable state,
and re-reads from it on the next run. The bus event is only a nudge; the cursor is the truth.

<!-- generated:automations -->
| Source | Method | Provider floor | Suggested | Signals |
|---|---|---|---|---|
| `gws.gmail` | `tools.gws.events_list` | 1 min | 2 min | `bus` |
| `gws.calendar` | `tools.gws.events_list` | 1 min | 10 min | `bus` |
<!-- /generated:automations -->

## A timer recipe

```js
// every 10 minutes
const state = (await tools.gws.events_list({ source: "calendar", account: "work" })) // no cursor: the first window
// keep state.cursor; on the next run:
const next = await tools.gws.events_list({ source: "calendar", account: "work", cursor: state.cursor })
```

- Pass the previous answer's `cursor` to continue; without one, a read starts at `since` or 24 hours ago.
- A cursor is bound to the plugin, source, account and scope. Another account's cursor is `CURSOR_INVALID`; start again
  without one.
- Keep the state per account and source. `events_list` never merges two accounts' windows.
- `gws.gmail` suggests every 2 minutes, and `gws.calendar` every 10; both are reads with no provider cost. Do not poll
  faster than the provider's floor.
- A `changed` event on `rpc.gws.changed` says a declared source changed after one of the plugin's writes. Re-read the
  named capability through RPC, or wait for the timer; the event carries no content.
- A page with `failed[]` holds the cursor back: the next run reads the same window again. A page with `refused[]` moved
  past those items for good.
