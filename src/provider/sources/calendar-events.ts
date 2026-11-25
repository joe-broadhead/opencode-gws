import { createHash } from "node:crypto"
import { decodeBoundCursor, encodeBoundCursor } from "@we-the-rebel-alliance/plugin-contract/cursor"
import {
  EVENT_LIMITS,
  type EventsListRequest,
  type EventsListResult,
  type EventsRemoval,
  type RefusedEvent,
  type SourceEvent,
  eventsListResult,
  makeEvent,
  oldestFirst,
  screenEvents,
  startTime,
} from "@we-the-rebel-alliance/plugin-contract/events"
import { eventInstant, knownZone } from "../domain/calendar.js"
import { stableEventId } from "../domain/calendar-id.js"
import { GwsError, throwIfCancelled } from "../domain/errors.js"
import type { CallContext } from "../accounts.js"
import type { Runtime } from "../index.js"
import { CURSOR_PLUGIN, PAGE_MAX_BYTES, PLUGIN_PACKAGE } from "./page.js"

/**
 * events_list for Calendar, the source `gws.calendar`: the meetings of the
 * account's primary calendar, as the source contract's events. Every call is
 * plain reads through the runtime, so each one passes the plugin's policy
 * and audit like a read; the tool asserts gws.events_list on
 * `calendar.events.list`, then gws.read on it and on the primary calendar's
 * read, before any of them runs.
 *
 * - A listing reads one bounded window: `timeMin`, and `timeMax` at seven
 *   days ahead. Google bounds `timeMin` by an event's end and `timeMax` by
 *   its start, so a recurring series is expanded only into the window, never
 *   years ahead; the source also drops an instance that starts at or past the
 *   window's own `timeMax`, whatever Google answers, never against a horizon
 *   from a later call's clock. A window drained over several calls keeps the
 *   bounds it opened with, so its cutoff never moves under an instance that
 *   was already inside it.
 * - The next call reads from the time the last window opened less an hour,
 *   not from the time of its last page, so a late run re-reads a bounded
 *   hour. That overlap is best-effort, not a catch-up guarantee: a change
 *   outside it, or an edit to an already-read row, may not return. Memory
 *   drops a repeat, so the overlap itself is harmless. A `since` in the
 *   future is read as now:
 *   there is nothing later to start from, and it must not shorten the window
 *   to an instant.
 * - Every provider page asks for the same `maxResults`, whatever the call's
 *   `limit`: a resumed page's saved index counts entries in that page, so a
 *   later call may pass another limit without moving the boundary under it.
 * - Within a page, outcomes are ordered by the persisted time and then by the
 *   stable external_id, never by the provider's position alone: a provider
 *   that answers two same-time items in the other order cannot move the
 *   cursor's place. Reusing an intra-page offset also checks a bounded page
 *   fingerprint of the items' identities, times, statuses and update times.
 *   A changed key set returns an empty restart page; the next call re-reads
 *   the saved window from its lower bound; after two restarts in one window
 *   the call fails with a next step instead of skipping or looping.
 * - At a provider page boundary, the cursor stores the consumed page's token
 *   (`q`) and a fixed digest (`h`) of the expected next token; the forward
 *   token itself is re-derived from the verified prior page. This keeps one
 *   350-character token in a checkpoint instead of two; the first page has no
 *   token to store. The next call re-reads that one page; a changed page or
 *   expected token restarts from the saved bounds. **Best effort:** the
 *   prior page can still change after verification but before the forward
 *   fetch, so an offset token can still miss a row. A change outside the
 *   one-hour overlap, or an edit to an already-read row, may not return. No
 *   lossless provider-paging guarantee is made.
 * - A persistent, bounded cycle/progress defense: a distinct advancing page
 *   token is progress even when the page is empty. The cursor keeps up to
 *   eight recent content-page token digests, and a 500-content-page cap per
 *   window; a repeated token (including A→B→C→A) or a window over the cap
 *   fails explicitly. Page 500 can be resumed to finish its own outcomes, but
 *   page 501 is not fetched. When a 128-character alias and a long token make
 *   the full history exceed 1,024 characters, the oldest history entries are
 *   dropped only as needed, so the effective history may be shorter; the hard
 *   ceiling remains. A restart resets only the attempt's history state, while
 *   `c` bounds restarts. This prevents an unbounded loop; it does not make
 *   pagination lossless.
 * - There is no sync token: a token reports changes, not the passing of
 *   time, so an unchanged instance entering the window would be missed.
 * - A page token is kept only up to 700 characters and the packed cursor
 *   must fit the contract's 1,024; a longer token fails with a clear next
 *   step instead of emitting a cursor this code would reject. Cursor times
 *   outside the Date range are `CURSOR_INVALID`, never a `RangeError`.
 * - Date-only values (`start.date`, `end.date`, `originalStartTime.date`)
 *   are converted at the primary calendar's `timeZone` from
 *   `calendarList.get`, falling back to UTC; a timed value keeps its own
 *   offset.
 * - `showDeleted: true` and `singleEvents: true` are set on every call, and
 *   the read asks for `recurringEventId` and `originalStartTime`. A cancelled
 *   instance with a start is listed with Google's `cancelled` status: one
 *   meeting with the same external_id (the event id), the `cancelled` label,
 *   and no text or actors. A cancelled item without a start cannot be a
 *   meeting: a recurring exception (`recurringEventId`/`originalStartTime`)
 *   and a deleted single event are both answered as removals by id. A
 *   recurring slot is never the removal's `at`.
 * - A recurring series deleted whole is not retracted: the window read
 *   sends no instance for it, and the instances already listed age out by
 *   Memory's retention. A removal guessed from an absence cannot tell a
 *   deletion from a meeting moved out of the window, and losing a real
 *   meeting is worse than the gap.
 * - An event holding a secret is refused for good (`refused[]`, reason
 *   `secret`). A page is one `events.list` answer, so no single event can
 *   fail on its own: the source never answers `failed[]`.
 * - One walk reads one ordered sequence of outcomes: a meeting to carry, one
 *   refused for good, or a removal. A page carries one prefix of that
 *   sequence, and a meeting, a refusal and a removal all take their bytes
 *   from the same `maxBytes` budget. The cursor resumes after the last
 *   outcome that prefix consumed. Exact duplicate outcomes in one response
 *   are dropped by a stable outcome hash; the same id with a different
 *   version is an explicit conflict that restarts (and fails after the same
 *   bound), never silently discarded. A restart or a fresh window may repeat
 *   an outcome, and the source promises at-least-once, never global
 *   exactly-once. A removal's `at` is Google's `updated` time when it is no
 *   later than the window's opening time and this call's `asOf`, else the
 *   window's opening time capped at `asOf`; a future provider time is not
 *   used until it is past and within `asOf`, and a repeat in a later window
 *   with no usable provider time is a new observation.
 * - A Calendar event id longer than the contract's 512 characters is named
 *   by the same deterministic `sha256:` id `calendar.today` uses: the prefix
 *   contains `:` and so cannot be a provider id (base32hex, `0-9a-v`). The
 *   event, its refusal and its removal all use that one id; an in-limit id
 *   is kept exactly and nothing is truncated.
 * - The scope is one calendar: `primary`, or the primary calendar's own id.
 *   The cursor is the contract's version 2, bound to (gws, calendar,
 *   account, scope), tagged with the checkpoint version `g` 1, and names a
 *   digest of the calendar's id, so a cursor from another account or
 *   calendar is refused. Only that shape is read: a cursor with a sync
 *   token, another checkpoint version, no window this source can resume or
 *   no checkpoint is `CURSOR_INVALID`, and the consumer starts again with
 *   `since`.
 */

/** The `source` input that names Calendar. */
export const CALENDAR_SOURCE = "calendar"

/** Every read events_list makes for Calendar. The tool asserts gws.read on `<account>:<operation>` for each before it runs any. */
export const CALENDAR_READS = ["calendar.calendarList.get", "calendar.events.list"] as const

/** The operation `gws.events_list` is asserted on: the one the listing follows. */
export const CALENDAR_FOLLOW = "calendar.events.list"

/** The one scope key this source declares. */
export const CALENDAR_SCOPE_KEYS: readonly string[] = ["calendars"]

/** The events Google returns per page. It never follows the call's own `limit`, so a resumed page's entry index stays valid. */
const PAGE_SIZE = 100
/** The most Google pages one call reads; the cursor carries on from there. */
const PAGES = 5
/** How far ahead a meeting is listed: only instances starting no later than this are emitted. */
const HORIZON_MS = 7 * 24 * 60 * 60 * 1000
/** How far before the window's opening time the next window starts, so a boundary instance is never lost. */
const OVERLAP_MS = 60 * 60 * 1000
/** The bytes a page's envelope may take outside its events, refusals and removals: owner, cursor, scope and timestamps, measured at most. */
const ENVELOPE_BYTES = 4096
/** The cursor checkpoint's version: a cursor without it predates the page fingerprint, so its numeric offset is not reused. */
const CHECKPOINT = 1
/** The most consecutive page-drift restarts one window tolerates before the call fails instead of looping. */
const PAGE_RESTARTS = 2
/** The page fingerprint's hex length: 128 bits of SHA-256 over the page's stable keys. */
const FINGERPRINT_HEX = 32
/** The expected-next-token digest length: 128 bits. */
const NEXT_HEX = 32
/** The cycle history keeps this many recent page-token digests: 64-bit each, enough for the bounded defense. */
const HISTORY = 8
const HISTORY_HEX = 16
/** The most content pages one window may read; a longer window fails explicitly instead of looping or replaying. */
const MAX_WINDOW_PAGES = 500
/** The longest provider page token kept in a cursor; the encoded cursor must also fit the contract's 1,024 characters. */
const PAGE_TOKEN_MAX = 700
/** The largest Date value in milliseconds; a cursor outside it would make every toISOString throw. */
const TIME_MAX = 8_640_000_000_000_000
/** The fields of one event: what a meeting needs, its recurrence markers, and nothing else. */
const EVENT_FIELDS =
  "nextPageToken,items(id,status,summary,description,location,start,end,updated,htmlLink,recurringEventId,originalStartTime(dateTime,date),organizer(email,displayName),attendees(email,displayName,self))"

/**
 * Where a listing stands, in the one shape this source writes. A finished
 * window names the time it opened (`r`, so the next window starts an hour
 * before it). A window being read names its bounds (`w`, `x`), the time it
 * opened (`i`), the checkpoint version (`g` 1), and the checkpoint. Within a
 * page, `p` is its token, `n` counts outcomes already read, and `f` is its
 * fingerprint. At a page boundary, `n` is zero, `f` is the consumed page's
 * fingerprint, `q` is the token that fetched it, and `h` is the digest of its
 * next token. The next call verifies the prior page and token digest before
 * following that token. `c` counts consecutive restarts. Anything else is
 * not this shape and is refused.
 */
interface CursorState {
  readonly r?: number
  readonly w?: number
  readonly x?: number
  readonly i?: number
  readonly p?: string
  readonly q?: string
  readonly n: number
  readonly g: number
  readonly f?: string
  readonly h?: string
  readonly j?: string
  readonly c?: number
  readonly e?: number
}

/** A window being read: both ends are known, when it opened, and where the checkpoint stands. */
interface OpenWindow {
  readonly w: number
  readonly x: number
  readonly i: number
  /** The page token to re-read for an intra-page offset; absent at a page boundary. */
  readonly p?: string
  /** The consumed page's token at a boundary; absent for the first page. */
  readonly q?: string
  readonly n: number
  readonly g: number
  readonly f?: string
  /** At a boundary, the digest of the next token the verified prior page must still name. */
  readonly h?: string
  /** The recent content-page token digests, dot-separated, for the persistent cycle defense. */
  readonly j?: string
  readonly c?: number
  readonly e?: number
}

/** The window to read, and whether its prior page must be verified first. */
interface Opened {
  readonly window: OpenWindow
  readonly verify: boolean
}

/**
 * One outcome of a page: a meeting to carry, one refused for good, or a
 * removal. `identity` is the external_id (mapped for an oversized provider
 * id), `key` is the page's stable provider key for drift detection, and
 * `order` only breaks an exact duplicate key's tie.
 */
interface Entry {
  readonly time: number
  readonly identity: string
  readonly key: string
  readonly order: number
  readonly event?: SourceEvent
  readonly refused?: RefusedEvent
  readonly removal?: EventsRemoval
}

/** An outcome, and where a cursor resumes after it. */
interface Step extends Entry {
  readonly after: OpenWindow
}

/** One page's sorted outcomes and its stable-key fingerprint. */
interface PageEntries {
  readonly entries: Entry[]
  readonly fingerprint: string
}

type Data = Record<string, unknown>

const record = (value: unknown): Data => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Data) : {})
const list = (value: unknown): Data[] => (Array.isArray(value) ? value.map(record) : [])

/** A digest of the calendar's id, so a cursor from another calendar is refused. */
const digest = (calendar: string) => createHash("sha256").update(calendar).digest("hex").slice(0, 16)

/** The cursor binding: the plugin, the source, the account and the calendar the call named. */
const binding = (account: string, named: string) => ({ plugin: CURSOR_PLUGIN, source: CALENDAR_SOURCE, account, scope: { calendars: [named] } })

/** The state a cursor holds, when this source, account and calendar issued it, in the one shape this source writes. */
function stateOf(cursor: string, account: string, named: string, calendar: string): CursorState {
  const decoded = decodeBoundCursor(binding(account, named), cursor)
  const state = decoded.ok ? decoded.state : undefined
  const refuse = () => new GwsError("CURSOR_INVALID", `the cursor was not issued by events_list for account '${account}' and this calendar, in the cursor shape it writes`)
  if (!state || state["a"] !== account || state["o"] !== digest(calendar)) throw refuse()
  const { r, w, x, i, g, f, h, j, c, e, n, p, q } = state
  // The checkpoint version is this design's tag: a cursor without it, or with another version, is not this shape.
  if (g !== CHECKPOINT) throw refuse()
  if (n !== undefined && (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)) throw refuse()
  if (r !== undefined && (typeof r !== "number" || !Number.isSafeInteger(r) || r < 0 || r > TIME_MAX)) throw refuse()
  if (w !== undefined && (typeof w !== "number" || !Number.isSafeInteger(w) || w < 0 || w > TIME_MAX)) throw refuse()
  if (i !== undefined && (typeof i !== "number" || !Number.isSafeInteger(i) || i < 0 || i > TIME_MAX)) throw refuse()
  if (f !== undefined && (typeof f !== "string" || !new RegExp(`^[0-9a-f]{${FINGERPRINT_HEX}}$`).test(f))) throw refuse()
  if (h !== undefined && (typeof h !== "string" || !new RegExp(`^[0-9a-f]{${NEXT_HEX}}$`).test(h))) throw refuse()
  if (j !== undefined && (typeof j !== "string" || !/^[0-9a-f]{16}(?:\.[0-9a-f]{16}){0,7}$/.test(j))) throw refuse()
  // The checkpoint's two shapes: an intra-page offset counts a fingerprinted page; a boundary names both the page it
  // consumed and the expected-next digest. Anything else is another version's cursor.
  if (h !== undefined && f === undefined) throw refuse()
  if (n !== undefined && n > 0 && f === undefined) throw refuse()
  if (f !== undefined && (n === undefined || n === 0) && h === undefined) throw refuse()
  if (c !== undefined && (typeof c !== "number" || !Number.isSafeInteger(c) || c < 0 || c > PAGE_RESTARTS)) throw refuse()
  if (e !== undefined && (typeof e !== "number" || !Number.isSafeInteger(e) || e < 0 || e > MAX_WINDOW_PAGES)) throw refuse()
  // A finished window names only the time it opened; a window being read names both bounds and the time it opened.
  if (r !== undefined && (w !== undefined || x !== undefined || i !== undefined)) throw refuse()
  if (r === undefined) {
    if (typeof w !== "number" || typeof x !== "number" || typeof i !== "number") throw refuse()
    if (!Number.isSafeInteger(x) || x > TIME_MAX || x <= w) throw refuse()
    if (i < w || i > x) throw refuse()
  }
  if (p !== undefined && (typeof p !== "string" || p.length === 0 || p.length > PAGE_TOKEN_MAX)) throw refuse()
  if (q !== undefined && (typeof q !== "string" || q.length === 0 || q.length > PAGE_TOKEN_MAX)) throw refuse()
  return {
    ...(typeof r === "number" ? { r } : {}),
    ...(typeof w === "number" ? { w } : {}),
    ...(typeof x === "number" ? { x } : {}),
    ...(typeof i === "number" ? { i } : {}),
    g,
    ...(typeof f === "string" ? { f } : {}),
    ...(typeof h === "string" ? { h } : {}),
    ...(typeof j === "string" ? { j } : {}),
    ...(typeof c === "number" ? { c } : {}),
    ...(typeof e === "number" ? { e } : {}),
    ...(typeof p === "string" ? { p } : {}),
    ...(typeof q === "string" ? { q } : {}),
    n: typeof n === "number" ? n : 0,
  }
}

/**
 * The window this call reads. A checkpointed open window resumes its bounds, opening time, page token and intra-page
 * offset; the page fingerprint says whether the same page is still there. A finished cursor starts the next window an
 * hour before the time it opened. A fresh call starts at `since`, or at the first run's 24 hours. A start later than
 * now is read as now, so the window keeps its seven days ahead instead of collapsing to an instant.
 */
function windowOf(state: CursorState | undefined, request: EventsListRequest, now: number): Opened {
  if (state !== undefined && state.w !== undefined && state.x !== undefined) {
    const i = state.i!
    if (state.n > 0) {
      return {
        window: {
          w: state.w,
          x: state.x,
          i,
          g: CHECKPOINT,
          ...(state.p === undefined ? {} : { p: state.p }),
          n: state.n,
          ...(state.f === undefined ? {} : { f: state.f }),
          ...(state.j === undefined ? {} : { j: state.j }),
          ...(state.c === undefined ? {} : { c: state.c }),
          ...(state.e === undefined ? {} : { e: state.e }),
        },
        verify: false,
      }
    }
    if (state.f !== undefined) {
      return {
        window: {
          w: state.w,
          x: state.x,
          i,
          g: CHECKPOINT,
          ...(state.q === undefined ? {} : { q: state.q }),
          n: 0,
          f: state.f,
          h: state.h!,
          ...(state.j === undefined ? {} : { j: state.j }),
          ...(state.c === undefined ? {} : { c: state.c }),
          ...(state.e === undefined ? {} : { e: state.e }),
        },
        verify: true,
      }
    }
    return {
      window: {
        w: state.w,
        x: state.x,
        i,
        g: CHECKPOINT,
        n: 0,
        ...(state.j === undefined ? {} : { j: state.j }),
        ...(state.c === undefined ? {} : { c: state.c }),
        ...(state.e === undefined ? {} : { e: state.e }),
      },
      verify: false,
    }
  }
  // stateOf accepts only a finished window or an open one; this keeps the two in step if that ever changes.
  if (state !== undefined && state.r === undefined) throw new GwsError("CURSOR_INVALID", "the cursor names no window this source can resume")
  const wanted = state?.r === undefined ? startTime(request, now) : Math.min(now, state.r) - OVERLAP_MS
  const x = Math.min(now + HORIZON_MS + 1, TIME_MAX)
  return { window: { w: Math.max(0, Math.min(wanted, now, x - 1)), x, i: Math.min(now, x), g: CHECKPOINT, n: 0 }, verify: false }
}

/**
 * The calendar a call reads: `primary`, or the account's own primary calendar id. Anything else is refused, so the
 * source can never be pointed at another person's calendar by a call.
 */
function calendarOf(request: EventsListRequest, primary: string): string {
  const named = request.scope?.["calendars"] ?? ["primary"]
  const ids = typeof named === "string" ? [named] : named
  if (ids.length !== 1) {
    throw new GwsError("INPUT_INVALID", "events_list reads one calendar at a time", { next: 'Pass one id under scope.calendars, such as "primary".' })
  }
  const id = ids[0]!
  if (id !== "primary" && id !== primary) {
    throw new GwsError("INPUT_INVALID", "the calendar named is not this account's primary calendar, the only one events_list reads", { next: 'Pass scope { "calendars": ["primary"] }, or omit scope.' })
  }
  return id
}

/** A start or end (a timed instant, or a date-only value at the calendar zone's midnight) in epoch milliseconds. */
function moment(value: unknown, zone: string): number | undefined {
  return eventInstant(value, zone)
}

/** When an instance begins. */
const begins = (item: Data, zone: string): number | undefined => moment(item["start"], zone)

/** When an instance ends, for the page's stable key. */
const ends = (item: Data, zone: string): number | undefined => moment(item["end"], zone)

/** When the event happens: its start; a cancellation is when it was cancelled. */
function occurred(item: Data, zone: string): number | undefined {
  const start = begins(item, zone)
  const updated = typeof item["updated"] === "string" ? Date.parse(item["updated"]) : undefined
  const time = item["status"] === "cancelled" ? (updated ?? start) : (start ?? updated)
  return time !== undefined && Number.isFinite(time) ? time : undefined
}

/**
 * A removal's stable page order and its contract `at`. The order is Google's `updated` when it is no later than the
 * window's opening time, else the opening time; it never uses a recurring slot. `at` is that order capped at this
 * call's `asOf`, so a clock regression cannot put it after the page's `asOf`. With no usable `updated`, `at` is the
 * opening time; a repeat in a later window is a new observation, not a promise of one global time.
 */
function removalTime(updated: number, opened: number, asOf: number): { at: number; order: number } {
  const order = Number.isFinite(updated) && updated <= opened ? updated : opened
  return { at: Math.min(order, asOf), order }
}

/** One meeting; a cancelled one keeps its id and title, with the cancelled label and no text or actors. */
function toEvent(item: Data, account: string, id: string, zone: string): SourceEvent | undefined {
  const time = occurred(item, zone)
  if (time === undefined) return undefined
  const title = typeof item["summary"] === "string" ? item["summary"] : ""
  const url = typeof item["htmlLink"] === "string" ? item["htmlLink"] : null
  const status = typeof item["status"] === "string" ? item["status"] : "confirmed"
  if (status === "cancelled") {
    return makeEvent({ source: CALENDAR_SOURCE, account, external_id: id, kind: "meeting", occurred_at: time, thread: null, actors: [], title, text: "", url, labels: ["cancelled"] })
  }
  const organizer = record(item["organizer"])
  const organizerEmail = typeof organizer["email"] === "string" ? organizer["email"] : undefined
  const actors = [
    ...(organizerEmail ? [{ role: "organizer", id: `mailto:${organizerEmail}`, ...(typeof organizer["displayName"] === "string" ? { name: organizer["displayName"] } : {}) }] : []),
    ...list(item["attendees"]).flatMap((attendee) => {
      const email = typeof attendee["email"] === "string" ? attendee["email"] : undefined
      if (!email) return []
      return [{ role: "attendee", id: `mailto:${email}`, ...(typeof attendee["displayName"] === "string" ? { name: attendee["displayName"] } : {}) }]
    }),
  ]
  const text = [typeof item["description"] === "string" ? item["description"] : "", typeof item["location"] === "string" ? item["location"] : ""].filter((part) => part.length > 0).join("\n\n")
  return makeEvent({ source: CALENDAR_SOURCE, account, external_id: id, kind: "meeting", occurred_at: time, thread: null, actors, title, text, url, labels: [status] })
}

/**
 * One page's outcomes in the order the cursor counts them. The order is the persisted window's time, then the stable
 * external_id (so a provider that reorders two items with the same start cannot move the cursor's place), then the
 * provider's order only for an exact duplicate key.
 *
 * A cancelled item with a start is a cancelled meeting. A cancelled item without a start cannot be a meeting: a
 * recurring exception (`recurringEventId`/`originalStartTime`) and a deleted single event are both removals by id; the
 * markers only supply a stable `at` when Google sends no usable `updated`. A confirmed item without a start is not an outcome.
 * The local cutoff is the window's persisted `timeMax` (`x`), never a new horizon from the call's clock; Google's
 * `timeMax` is exclusive, so an instance at `x` is out and one at `x - 1` is in.
 */
function pageEntries(items: readonly Data[], account: string, bound: number, opened: number, asOf: number, zone: string): PageEntries {
  const entries: Entry[] = []
  for (const [order, item] of items.entries()) {
    const raw = typeof item["id"] === "string" ? item["id"] : undefined
    if (!raw) continue
    // The same stable id names the event, its refusal and its removal; an in-limit id is kept exactly.
    const identity = stableEventId(raw, EVENT_LIMITS.externalId)
    const start = begins(item, zone)
    const end = ends(item, zone)
    const status = typeof item["status"] === "string" ? item["status"] : "confirmed"
    const updated = typeof item["updated"] === "string" ? Date.parse(item["updated"]) : Number.NaN
    if (start === undefined) {
      if (status !== "cancelled") continue
      const original = moment(item["originalStartTime"], zone)
      const { at, order: time } = removalTime(updated, opened, asOf)
      entries.push({
        time,
        identity,
        key: JSON.stringify([raw, status, null, end ?? null, Number.isFinite(updated) ? updated : null, original ?? null, "removal"]),
        order,
        removal: { external_id: identity, at: new Date(at).toISOString(), reason: "deleted" },
      })
      continue
    }
    if (start >= bound) continue
    const event = toEvent(item, account, identity, zone)
    if (event === undefined) continue
    const screened = screenEvents([event])
    const refused = screened.refused[0]
    entries.push({
      time: Date.parse(event.occurred_at),
      identity,
      key: JSON.stringify([raw, status, start, end ?? null, Number.isFinite(updated) ? updated : null, refused === undefined ? "event" : "refused"]),
      order,
      event,
      ...(refused === undefined ? {} : { refused }),
    })
  }
  entries.sort((a, b) => a.time - b.time || (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : a.order - b.order))
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(entries.map((entry) => entry.key)))
    .digest("hex")
    .slice(0, FINGERPRINT_HEX)
  return { entries, fingerprint }
}

/**
 * Lists the meetings of `account`'s primary calendar from the request's
 * cursor, or since its `since`, and no further ahead than seven days. A
 * cancellation Google answers without a start is answered as a removal by
 * id. `runtime.read` runs each read under the plugin's read policy; `ctx`
 * cancels them.
 */
export async function calendarEvents(runtime: Pick<Runtime, "read">, account: string, request: EventsListRequest, ctx: CallContext, now = Date.now()): Promise<EventsListResult> {
  const read = async (operation: string, params: Data, fields: string): Promise<Data> => record((await runtime.read({ account, operation, params, fields }, ctx)).data)

  // The primary calendar names the account: a Calendar-only sign-in has no Gmail profile to read.
  const primary = await read("calendar.calendarList.get", { calendarId: "primary" }, "id,summary,timeZone")
  const calendar = typeof primary["id"] === "string" ? primary["id"].trim() : ""
  if (!calendar) throw new GwsError("GWS_API_ERROR", "the primary calendar answered without an id")
  const zone = knownZone(primary["timeZone"]) ? primary["timeZone"] : "UTC"
  const owner = { id: `mailto:${calendar}`, label: typeof primary["summary"] === "string" && primary["summary"] !== "" ? primary["summary"] : calendar }
  const named = calendarOf(request, calendar)
  const at = new Date(now).toISOString()
  const opened = windowOf(request.cursor === undefined ? undefined : stateOf(request.cursor, account, named, calendar), request, now)
  let page = opened.window
  const openedAt = page.i
  const scope = { calendars: [named] }
  const pack = (state: Readonly<Record<string, unknown>>): string => {
    const history = typeof state["j"] === "string" && state["j"].length > 0 ? state["j"].split(".") : []
    // Preserve the full cycle history when it fits; drop only the oldest entries if the 1,024-character ceiling requires it.
    for (let keep = history.length; keep >= 0; keep--) {
      const candidate = { ...state, j: keep === 0 ? undefined : history.slice(-keep).join(".") }
      try {
        return encodeBoundCursor(binding(account, named), candidate)
      } catch {
        if (keep > 0) continue
        throw new GwsError("GWS_API_ERROR", "the checkpoint is too large to keep in a cursor: the account, page token and history together exceed 1,024 characters", {
          next: "Call events_list again later; a later since does not necessarily shrink a stable or future-only window.",
        })
      }
    }
    // The loop either returns or throws; this is unreachable but keeps the return type total.
    throw new GwsError("GWS_API_ERROR", "the checkpoint could not be encoded")
  }
  // A page that makes no progress: its membership changed under the fingerprint its cursor stored.
  const restartPage = (count?: number, reason: "changed" | "conflict" = "changed"): EventsListResult => {
    if (count !== undefined && count > PAGE_RESTARTS) {
      const what = reason === "conflict" ? "the calendar returned two versions of the same outcome in one page" : "the calendar changed the same page while it was being read"
      throw new GwsError("GWS_API_ERROR", what, {
        next: "Call events_list again; a fresh since may start a new window if the same change keeps recurring.",
      })
    }
    return eventsListResult(
      { source: CALENDAR_SOURCE, account, owner },
      [],
      pack({ a: account, o: digest(calendar), g: CHECKPOINT, w: page.w, x: page.x, i: page.i, n: 0, ...(count === undefined ? {} : { c: count }) }),
      true,
      { scope, plugin: PLUGIN_PACKAGE, asOf: at },
    )
  }
  // One ordered walk of what Google answered from the cursor's place: every outcome and where the cursor resumes after it.
  const steps: Step[] = []
  const seen = { event: new Map<string, string>(), removal: new Map<string, string>() }
  const digestOf = (token: string, hex: number) => createHash("sha256").update(token).digest("hex").slice(0, hex)
  let history = page.j === undefined ? [] : page.j.split(".")
  let pagesRead = page.e ?? 0
  let forward = page.p
  let reuse = page.n > 0
  let pages = 0
  let complete = false
  let first = true
  const carried = () => steps.filter((step) => step.event !== undefined && step.refused === undefined).length
  const keep = (value: string): void => {
    const digest = digestOf(value, HISTORY_HEX)
    if (history.includes(digest)) {
      throw new GwsError("GWS_API_ERROR", "the calendar repeated a page token, so the read cannot make progress", {
        next: "Call events_list again later; if the provider keeps repeating tokens, the window cannot be paged safely. A later since does not necessarily help a stable window.",
      })
    }
    history = [...history, digest].slice(-HISTORY)
  }
  const checkLength = (value: string): void => {
    if (value.length > PAGE_TOKEN_MAX) {
      throw new GwsError("GWS_API_ERROR", "the calendar's page token is too long to keep in a cursor", {
        next: "Call events_list again later; this provider token cannot be checkpointed in 1,024 characters. A later since may return the same token for a stable window.",
      })
    }
  }
  const listPage = async (token: string | undefined): Promise<{ data: Data; entries: Entry[]; fingerprint: string }> => {
    throwIfCancelled(ctx.signal)
    const data = await read(
      "calendar.events.list",
      {
        calendarId: "primary",
        showDeleted: true,
        singleEvents: true,
        orderBy: "startTime",
        timeMin: new Date(page.w).toISOString(),
        timeMax: new Date(page.x).toISOString(),
        maxResults: PAGE_SIZE,
        ...(token ? { pageToken: token } : {}),
      },
      EVENT_FIELDS,
    )
    pages += 1
    // The local cutoff is the window's persisted upper bound, and date-only values use the calendar's zone.
    return { data, ...pageEntries(list(data["items"]), account, page.x, openedAt, now, zone) }
  }
  // At a boundary, re-read the one consumed page first: its unchanged fingerprint and expected next-token digest are
  // the checkpoint. The next token is re-derived from that verified page, never stored beside the prior token.
  if (opened.verify) {
    let verified: { data: Data; entries: Entry[]; fingerprint: string }
    try {
      verified = await listPage(page.q)
    } catch (error) {
      const status = GwsError.from(error)?.status
      if (status === 400 || status === 404) return restartPage((page.c ?? 0) + 1)
      throw error
    }
    const next = typeof verified.data["nextPageToken"] === "string" && verified.data["nextPageToken"] !== "" ? verified.data["nextPageToken"] : undefined
    if (verified.fingerprint !== page.f || next === undefined || digestOf(next, NEXT_HEX) !== page.h) return restartPage((page.c ?? 0) + 1)
    checkLength(next)
    forward = next
    reuse = false
  }
  const outcomeHash = (entry: Entry): string =>
    createHash("sha256")
      .update(JSON.stringify([entry.key, entry.event ?? null, entry.refused ?? null, entry.removal ?? null]))
      .digest("hex")
  while (carried() < request.limit && pages < PAGES) {
    const token = forward
    // A re-read of the cursor's own page is already in the history; any other forward page is checked before it runs.
    const reread = reuse
    if (!reread && pagesRead >= MAX_WINDOW_PAGES) {
      throw new GwsError("GWS_API_ERROR", "the calendar window has more pages than one listing may read", {
        next: "Call events_list again later; the window cannot be paged safely at this size. A later since does not necessarily shrink a future-only window.",
      })
    }
    if (!reread && token !== undefined) keep(token)
    reuse = false
    const { data, entries, fingerprint } = await listPage(token)
    if (!reread) pagesRead += 1
    // Reusing an intra-page offset is safe only against the same page: a changed key set restarts from the saved bounds.
    if (first && page.n > 0 && (page.n > entries.length || page.f === undefined || fingerprint !== page.f)) {
      return restartPage((page.c ?? 0) + 1)
    }
    // The cursor's page has already answered its first `n` outcomes; every later page starts at its first.
    const from = first ? page.n : 0
    first = false
    for (let index = from; index < entries.length; index++) {
      const entry = entries[index]!
      // Exact outcomes dedupe; the same id with a different version is an explicit conflict, never silently dropped.
      const hash = outcomeHash(entry)
      const bucket = entry.removal === undefined ? seen.event : seen.removal
      const known = bucket.get(entry.identity)
      if (known !== undefined) {
        if (known === hash) continue
        return restartPage((page.c ?? 0) + 1, "conflict")
      }
      bucket.set(entry.identity, hash)
      // Where the listing stands after this outcome: within the page it was read from, never the next page yet.
      steps.push({
        ...entry,
        after: {
          w: page.w,
          x: page.x,
          i: page.i,
          g: CHECKPOINT,
          f: fingerprint,
          ...(token ? { p: token } : {}),
          n: index + 1,
          ...(page.c === undefined ? {} : { c: page.c }),
          ...(history.length === 0 ? {} : { j: history.join(".") }),
          e: pagesRead,
        },
      })
    }
    const nextPage = typeof data["nextPageToken"] === "string" && data["nextPageToken"] !== "" ? data["nextPageToken"] : undefined
    if (nextPage) {
      checkLength(nextPage)
      // Keep the consumed page's token and the forward token's digest. A resumed call re-derives the forward token.
      page = {
        w: page.w,
        x: page.x,
        i: page.i,
        g: CHECKPOINT,
        ...(token === undefined ? {} : { q: token }),
        f: fingerprint,
        h: digestOf(nextPage, NEXT_HEX),
        ...(history.length === 0 ? {} : { j: history.join(".") }),
        n: 0,
        ...(page.c === undefined ? {} : { c: page.c }),
        e: pagesRead,
      }
      forward = nextPage
      continue
    }
    complete = true
    break
  }
  // One prefix, one budget: a meeting, a refusal and a removal all take their bytes from the same page.
  let take = 0
  let events = 0
  let refusedCount = 0
  let removalCount = 0
  let bytes = 0
  for (const step of steps) {
    if (step.event !== undefined && step.refused === undefined) {
      if (events === request.limit) break
    }
    if (step.refused !== undefined && refusedCount === EVENT_LIMITS.refused) break
    if (step.removal !== undefined && removalCount === EVENT_LIMITS.refused) break
    const size = Buffer.byteLength(JSON.stringify(step.event ?? step.refused ?? step.removal)) + 1
    if (take > 0 && bytes + size > PAGE_MAX_BYTES - ENVELOPE_BYTES) break
    bytes += size
    take += 1
    if (step.event !== undefined && step.refused === undefined) events += 1
    if (step.refused !== undefined) refusedCount += 1
    if (step.removal !== undefined) removalCount += 1
  }
  // A page always advances by one outcome, even the largest single event: the contract's event limits keep it under the cap.
  if (take === 0 && steps.length > 0) take = 1

  const cursorAt = (count: number): Readonly<Record<string, unknown>> => {
    if (count < steps.length) return { a: account, o: digest(calendar), ...steps[count - 1]!.after }
    if (complete) return { a: account, o: digest(calendar), g: CHECKPOINT, r: openedAt }
    return {
      a: account,
      o: digest(calendar),
      g: CHECKPOINT,
      w: page.w,
      x: page.x,
      i: page.i,
      ...(page.q === undefined ? {} : { q: page.q }),
      ...(page.f === undefined ? {} : { f: page.f }),
      ...(page.h === undefined ? {} : { h: page.h }),
      ...(page.j === undefined ? {} : { j: page.j }),
      n: 0,
      ...(page.c === undefined ? {} : { c: page.c }),
      ...(page.e === undefined ? {} : { e: page.e }),
    }
  }
  const pageAt = (count: number): EventsListResult => {
    const used = steps.slice(0, count)
    const refused = used.flatMap((step) => (step.refused === undefined ? [] : [step.refused]))
    const removals = used.flatMap((step) => (step.removal === undefined ? [] : [step.removal]))
    return eventsListResult(
      { source: CALENDAR_SOURCE, account, owner },
      oldestFirst(used.flatMap((step) => (step.event !== undefined && step.refused === undefined ? [step.event] : []))),
      pack(cursorAt(count)),
      count < steps.length || !complete,
      {
        scope,
        plugin: PLUGIN_PACKAGE,
        asOf: at,
        refused,
        ...(removals.length === 0 ? {} : { removals }),
      },
    )
  }
  let result = pageAt(take)
  // The estimate above leaves the envelope room; measure the page itself so refusals and removals cannot push it over.
  while (take > 1 && Buffer.byteLength(JSON.stringify(result)) > PAGE_MAX_BYTES) {
    take -= 1
    result = pageAt(take)
  }
  return result
}
