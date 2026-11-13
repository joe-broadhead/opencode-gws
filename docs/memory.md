# Memory

Memory Jobs (opencode-mem) reads from this plugin over the tools RPC and curates what it reads into memories and
pages. Memory owns the schedule, budgets and every write; this plugin is a **read-only connector**. Nothing is read
unless the person confirms a binding in Memory's console, and the binding stores exactly the grants below.

The declaration is `package.json#memory`, schema v2, checked by Memory's kit: `node plugin-kit/check.mjs <this repo>`
from an opencode-mem checkout, and in this repo's own suite by `test/memory-declaration.test.ts`.

## What Memory reads

Two `events_list` sources (see [Events list](configuration.md#events-list)):

| Source | Events | Scope | Identity |
| --- | --- | --- | --- |
| `gmail` | the messages in the signed-in mailbox | none: the whole mailbox | `events_list` with `{ source: "gmail", limit: 0 }` |
| `calendar` | the primary calendar's events and cancellations | `calendars`: one id, `primary` by default | `events_list` with `{ source: "calendar", limit: 0 }` |

The grants are exactly what each call asserts: `gws.events_list` on `*` and `gws.read` on
`{account}:gmail.users.getProfile` (Gmail's identity), and on `{account}:calendar.calendarList.get` (Calendar's
identity), plus the reads a full listing makes, which the manifest lists. A job's session allows nothing else.

The connector's direct read, `gws.read` on `{account}:calendar.events.list`, is grantable because the tools RPC
resolves each method's own `<account>:<operation>` before dispatch. Before that change the RPC checked `gws.read` on
`*`, which would have allowed every gws read on every account, so the connector declares `operationScoped: true` only
now. A session that allows one operation does not allow another, another account, or a call that names no account.

## Jobs and templates

Two optional templates are declared: `gmail-commitments` (commitments proposed from the mailbox, with timeline lines
on person pages) and `calendar-meetings` (a meeting page per event, with follow-ups proposed). Instantiating one
copies it into Memory's job library; enabling it is a normal activation, and a template never carries grants or an
account.

## Pausing and removing it

- In Memory, pause the job or the binding; the plugin then receives no calls. `RECORDS_JOBS=off` stops the runner.
- In OpenCode, a deny rule on `gws.events_list` turns the source off without touching `gws_read`; a deny on `gws.read`
  on the operations above narrows a listing.
- Uninstall this plugin, or remove Memory's binding, to stop collection entirely.
