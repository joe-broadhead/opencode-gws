import { createHash } from "node:crypto"
import { GwsError, throwIfCancelled } from "../domain/errors.js"
import type { CallContext } from "../runtime/accounts.js"
import type { Runtime } from "../runtime/index.js"
import {
  type EventsListRequest,
  type EventsListResult,
  type EventsScope,
  type SourceEvent,
  decodeCursor,
  encodeCursor,
  eventsListResult,
  fitPage,
  makeEvent,
  oldestFirst,
  startTime,
} from "./events-list.js"

/**
 * events_list for Calendar: the events of the account's primary calendar
 * since a cursor, as the funnel's events (`events-list.ts`), for Memory's
 * collector. Every call is plain reads through the runtime, so each one
 * passes the plugin's policy and audit like a gws_read; the tool asserts
 * gws.events_list on `calendar.events.list`, then gws.read on it and on the
 * identity read, before any of them runs.
 *
 * - The first listing (no cursor) is a full sync from `since`: one
 *   `calendar.events.list` walk with `timeMin`, oldest first.
 * - After that it follows `syncToken`, which Google answers with the events
 *   that changed since. `nextSyncToken` arrives only on the last page, so a
 *   run that stops early resumes from the page token (and the entry within
 *   that page), not from the sync token.
 * - A sync token Google has expired answers HTTP 410: the source starts a
 *   full sync again from the last event it listed. Memory records the gap.
 * - `showDeleted: true` and `singleEvents: true` are set on every call, so a
 *   cancelled event is listed as `status: "cancelled"` and becomes a
 *   withdrawal: one event with the same external_id (the event id), `kind:
 *   "event"`, the `cancelled` label, and no title, text or actors from the
 *   meeting it retires.
 * - The cursor names the account and a digest of the calendar's id, so a
 *   cursor from another account or calendar is refused.
 */

/** The `source` of Calendar events. */
export const CALENDAR_SOURCE = "calendar"

/** Every read events_list makes, the identity read first. The tool asserts gws.read on `<account>:<operation>` for each before it runs any. */
export const CALENDAR_READS = ["calendar.calendarList.get", "calendar.events.list"] as const

/** The operation `gws.events_list` is asserted on: the one the listing follows. */
export const CALENDAR_FOLLOW = "calendar.events.list"

/** Contract 2's setup line: what the person confirms before Memory collects from this source. */
export const CALENDAR_SETUP = "Choose the calendar to collect when you confirm; the primary calendar is the default."

/** The one scope key this source declares. */
export const CALENDAR_SCOPE_KEY = "calendars"

/** The events Google returns per page; the call's own `limit` may be smaller. */
const PAGE_SIZE = 100
/** The most Google pages one call reads; the cursor carries on from there. */
const PAGES = 5
/** The fields of one event: what a meeting page and its withdrawals need, and nothing else. */
const EVENT_FIELDS =
  "nextPageToken,nextSyncToken,items(id,status,summary,description,location,start,end,updated,htmlLink,organizer(email,displayName,self),attendees(email,displayName,responseStatus,self))"

/**
 * Where a listing stands: the sync token of the last completed sync (`""`
 * during a full sync), the full sync's window start (`w`), the last event's
 * time (`t`, where a 410 restarts from), the page token to resume at when one
 * was used (`p`), and how many of that page's entries are already read (`n`).
 */
interface Sync {
  readonly k: "s"
  readonly y: string
  readonly w: number
  readonly t: number
  readonly p?: string
  readonly n: number
}

type Data = Record<string, unknown>

const record = (value: unknown): Data => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Data) : {})
const list = (value: unknown): Data[] => (Array.isArray(value) ? value.map(record) : [])

/** A digest of the calendar's id, so a cursor from another calendar is refused. */
const digest = (calendar: string) => createHash("sha256").update(calendar).digest("hex").slice(0, 16)

/** The state a cursor holds, when this account's primary calendar issued it. */
function stateOf(cursor: string, account: string, calendar: string): Sync {
  const state = decodeCursor(CALENDAR_SOURCE, cursor)
  const refuse = () => new GwsError("CURSOR_INVALID", `the cursor was not issued by events_list for account '${account}' and its primary calendar`)
  if (!state || state["a"] !== account || state["o"] !== digest(calendar)) throw refuse()
  const { y, w, t, n, p } = state
  if (typeof y !== "string" || y.length > 512) throw refuse()
  if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 0) throw refuse()
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw refuse()
  if (y === "") {
    if (typeof w !== "number" || !Number.isSafeInteger(w) || w < 0) throw refuse()
  } else if (w !== 0) throw refuse()
  if (p !== undefined && (typeof p !== "string" || p.length === 0 || p.length > 512)) throw refuse()
  return { k: "s", y, w: y === "" ? (w as number) : 0, t, ...(typeof p === "string" ? { p } : {}), n }
}

/**
 * The scope this call reads: one calendar, `primary` or the account's own
 * primary calendar id. Anything else is refused, so the source can never be
 * pointed at another person's calendar by a call.
 */
function scopeOf(request: EventsListRequest, calendar: string): EventsScope {
  const scope = request.scope ?? {}
  for (const key of Object.keys(scope)) {
    if (key !== CALENDAR_SCOPE_KEY) {
      throw new GwsError("GWS_VALIDATION_ERROR", `Calendar has no scope key '${key}': its only key is calendars`, { next: 'Pass scope { "calendars": ["primary"] }, or omit it.' })
    }
  }
  const ids = scope[CALENDAR_SCOPE_KEY] ?? ["primary"]
  if (ids.length !== 1) {
    throw new GwsError("GWS_VALIDATION_ERROR", "events_list reads one calendar at a time", { next: 'Pass one id under scope.calendars, such as "primary".' })
  }
  const id = ids[0]!
  if (id !== "primary" && id !== calendar) {
    throw new GwsError("GWS_VALIDATION_ERROR", `the calendar '${id}' is not this account's primary calendar`, { next: 'Pass scope { "calendars": ["primary"] }.' })
  }
  return { [CALENDAR_SCOPE_KEY]: [id] }
}

/** When the event happens: its start, or for an all-day event its date at UTC midnight; a cancellation is when it was cancelled. */
function occurred(item: Data): number | undefined {
  const start = record(item["start"])
  const dateTime = typeof start["dateTime"] === "string" ? start["dateTime"] : typeof start["date"] === "string" ? `${start["date"]}T00:00:00Z` : undefined
  const updated = typeof item["updated"] === "string" ? item["updated"] : undefined
  const time = Date.parse((item["status"] === "cancelled" ? (updated ?? dateTime) : (dateTime ?? updated)) ?? "")
  return Number.isFinite(time) ? time : undefined
}

/** One event, or a withdrawal when Google lists it as cancelled: the same id, no meeting title, text or actors. */
function toEvent(item: Data, account: string): SourceEvent | undefined {
  const id = typeof item["id"] === "string" ? item["id"] : undefined
  const time = occurred(item)
  if (!id || time === undefined) return undefined
  const title = typeof item["summary"] === "string" ? item["summary"] : ""
  const url = typeof item["htmlLink"] === "string" ? item["htmlLink"] : null
  if (item["status"] === "cancelled") {
    return makeEvent({ source: CALENDAR_SOURCE, account, external_id: id, kind: "event", occurred_at: time, thread: null, actors: [], title, text: "", url, labels: ["calendar", "cancelled"] })
  }
  const organizer = record(item["organizer"])
  const organizerEmail = typeof organizer["email"] === "string" ? organizer["email"] : undefined
  const actors = [
    ...(organizerEmail ? [{ role: "organizer", id: `mailto:${organizerEmail}`, ...(typeof organizer["displayName"] === "string" ? { name: organizer["displayName"] } : {}) }] : []),
    ...list(item["attendees"]).flatMap((attendee) => {
      const email = typeof attendee["email"] === "string" ? attendee["email"] : undefined
      if (!email) return []
      const role = attendee["self"] === true ? "self" : "attendee"
      return [{ role, id: `mailto:${email}`, ...(typeof attendee["displayName"] === "string" ? { name: attendee["displayName"] } : {}) }]
    }),
  ]
  const text = [typeof item["description"] === "string" ? item["description"] : "", typeof item["location"] === "string" ? item["location"] : ""].filter((part) => part.length > 0).join("\n\n")
  return makeEvent({ source: CALENDAR_SOURCE, account, external_id: id, kind: "meeting", occurred_at: time, thread: null, actors, title, text, url, labels: ["calendar", typeof item["status"] === "string" ? item["status"] : "confirmed"] })
}

/**
 * Lists the events of `account`'s primary calendar after the request's
 * cursor, or since its `since`. `runtime.read` runs each read under the
 * plugin's read policy; `ctx` cancels them.
 */
export async function calendarEvents(runtime: Pick<Runtime, "read">, account: string, request: EventsListRequest, ctx: CallContext, now = Date.now()): Promise<EventsListResult> {
  const read = async (operation: string, params: Data, fields: string): Promise<Data> =>
    record((await runtime.read({ account, operation, params, fields }, ctx)).data)

  // The identity read: a Calendar-only sign-in has no Gmail scope, so the primary calendar names the account.
  const primary = await read("calendar.calendarList.get", { calendarId: "primary" }, "id,summary,timeZone")
  const calendar = typeof primary["id"] === "string" ? primary["id"].trim() : ""
  if (!calendar) throw new GwsError("GWS_API_ERROR", "the primary calendar answered without an id")
  const owner = { id: calendar, label: calendar }
  const scope = scopeOf(request, calendar)
  let state: Sync = request.cursor === undefined ? { k: "s", y: "", w: startTime(request, now), t: startTime(request, now), n: 0 } : stateOf(request.cursor, account, calendar)
  const identity = { source: CALENDAR_SOURCE, account, owner, scope, setup: CALENDAR_SETUP }
  // Contract 2's owner-only call: the identity and the scope options, and no events read.
  if (request.limit === 0) return eventsListResult(identity, [], encodeCursor(CALENDAR_SOURCE, { a: account, o: digest(calendar), ...state }), false)

  const listed: Array<{ event: SourceEvent; after: Sync }> = []
  let resynced = false
  let pages = 0
  while (listed.length < request.limit && pages < PAGES) {
    throwIfCancelled(ctx.signal)
    // A full sync reads from its window; a sync token reads what changed, and takes no window.
    const window = state.y === "" ? { timeMin: new Date(state.w).toISOString() } : { syncToken: state.y }
    const params: Data = { calendarId: "primary", showDeleted: true, singleEvents: true, maxResults: Math.min(PAGE_SIZE, Math.max(1, request.limit)), ...window, ...(state.p ? { pageToken: state.p } : {}) }
    let data: Data
    try {
      data = await read("calendar.events.list", params, EVENT_FIELDS)
    } catch (error) {
      // An expired sync token: start the full sync again from the last event listed. Google never expires a page token.
      if (state.y !== "" && GwsError.from(error)?.status === 410) {
        if (resynced) throw error
        resynced = true
        state = { k: "s", y: "", w: state.t, t: state.t, n: 0 }
        continue
      }
      throw error
    }
    pages += 1
    const items = list(data["items"])
    const nextPage = typeof data["nextPageToken"] === "string" && data["nextPageToken"] !== "" ? data["nextPageToken"] : undefined
    const nextSync = typeof data["nextSyncToken"] === "string" && data["nextSyncToken"] !== "" ? data["nextSyncToken"] : undefined
    const pageToken = state.p
    // Google does not promise a page's order, and a sync token forbids orderBy: sort the page's events, so a call's
    // events are oldest first and the cursor's entry index names a stable place in a stable page.
    const events = items.flatMap((item) => {
      const event = toEvent(item, account)
      return event === undefined ? [] : [event]
    }).map((event, index) => ({ event, index, time: Date.parse(event.occurred_at) })).sort((a, b) => a.time - b.time || a.index - b.index)
    let time = state.t
    for (let index = state.n; index < events.length; index++) {
      const event = events[index]!.event
      time = Math.max(time, events[index]!.time)
      // Where the listing stands after this event: within the page it was read from, never the new sync token yet.
      const after: Sync = { k: "s", y: state.y, w: state.w, ...(pageToken ? { p: pageToken } : {}), n: index + 1, t: time }
      listed.push({ event, after })
    }
    // The whole page is read (an API page is never larger than the call's limit), so a last page's sync token is adopted now.
    state = nextSync
      ? { k: "s", y: nextSync, w: 0, t: time, n: 0 }
      : { k: "s", y: state.y, w: state.w, ...(nextPage ? { p: nextPage } : {}), n: 0, t: time }
    // The sync token is only on the last page, so that page ends the walk.
    if (nextSync) break
    if (listed.length >= request.limit) break
  }

  const kept = fitPage(listed.map((item) => item.event), request.limit)
  let more: boolean
  if (kept < listed.length) {
    // The page cap trimmed the result: resume from the event that was listed last, inside its page.
    state = listed[kept - 1]!.after
    more = true
  } else {
    more = state.p !== undefined
  }
  return eventsListResult(identity, oldestFirst(listed.slice(0, kept).map((item) => item.event)), encodeCursor(CALENDAR_SOURCE, { a: account, o: digest(calendar), ...state }), more)
}
