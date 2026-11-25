import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { decodeBoundCursor, encodeBoundCursor } from "@we-the-rebel-alliance/plugin-contract/cursor"
import { type EventsListRequest, type SourceEvent, resultProblems } from "@we-the-rebel-alliance/plugin-contract/events"
import { describe, expect, it } from "vitest"
import { stableEventId } from "../../src/provider/domain/calendar-id.js"
import { calendarEvents } from "../../src/provider/sources/calendar-events.js"
import type { CallContext } from "../../src/provider/accounts.js"
import type { Runtime } from "../../src/provider/index.js"

/**
 * `gws.calendar`'s horizon and its removals. The source lists only the meeting instances that start no later than
 * seven days ahead, and re-reads from the last run's time less an hour, so a meeting created, moved or cancelled after
 * the last run arrives; a late run catches up. It also retracts what it listed inside that window when a whole series
 * vanishes, and a cancellation Google answers without a start. The source is read at its own seam (`calendarEvents`),
 * with the Google answer stubbed in process. The stub over-answers past `timeMax` on purpose: the source's own horizon
 * is what the tests hold, and the request's `timeMax` is asserted too.
 */

const ACCOUNT = "personal"
const CALENDAR = "sam.rivera@example.com"
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
/** The horizon the source promises: seven days from the read's own now. */
const HORIZON = 7 * DAY
/** The contract's first-run window. */
const FIRST_RUN = 24 * HOUR
const NOW = Date.parse("2026-11-01T00:00:00Z")
const iso = (ms: number) => new Date(ms).toISOString()
const ctx: CallContext = { sessionId: "ses_calendar_horizon", agentId: "build", signal: new AbortController().signal }

interface Item {
  readonly id: string
  readonly status?: string
  readonly summary?: string
  readonly description?: string
  readonly start?: { readonly dateTime?: string; readonly date?: string }
  readonly end?: { readonly dateTime?: string; readonly date?: string }
  readonly updated?: string
  readonly htmlLink?: string
  readonly recurringEventId?: string
  readonly originalStartTime?: { readonly dateTime?: string; readonly date?: string }
}

/** The cursor binding the tests decode: the plugin, the source, the account and the primary calendar. */
const BINDING = { plugin: "gws", source: "calendar", account: ACCOUNT, scope: { calendars: ["primary"] } }

/** One confirmed meeting, an hour long, from its start. */
function meeting(id: string, start: string, extra: Partial<Item> = {}): Item {
  return { id, status: "confirmed", summary: id, start: { dateTime: start }, end: { dateTime: iso(Date.parse(start) + HOUR) }, updated: "2026-10-31T00:00:00Z", ...extra }
}

const timeOf = (value: Item["start"]): number | undefined => {
  const at = typeof value?.dateTime === "string" ? value.dateTime : typeof value?.date === "string" ? `${value.date}T00:00:00Z` : undefined
  const parsed = Date.parse(at ?? "")
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Google's answer, stubbed: `calendar.calendarList.get`, then `calendar.events.list` filtered only by `timeMin` (the
 * lower bound on an event's end). It never applies `timeMax`, so an item past the horizon is still answered and only
 * the source's own horizon keeps it out. An item with neither a start nor an end is a tombstone and is always answered.
 * The item list is held by reference, so a test changes what Google has between calls. Each call's params are recorded.
 */
function google(items: readonly Item[], zone = "UTC") {
  const calls: Array<Record<string, unknown>> = []
  const fields: string[] = []
  const read = async (request: { operation: string; params?: Record<string, unknown>; fields?: string }) => {
    if (request.operation === "calendar.calendarList.get") return { data: { id: CALENDAR, summary: "Sam Rivera", timeZone: zone } }
    fields.push(request.fields ?? "")
    const params = request.params ?? {}
    calls.push(params)
    const from = Date.parse(String(params["timeMin"] ?? "invalid"))
    const page = Number(params["pageToken"] ?? 0)
    if (!Number.isInteger(page) || page < 0) throw new Error(`the stub has no page ${String(params["pageToken"])}`)
    // One page holds everything; a pageToken is only ever the empty second page.
    const answered =
      page === 0
        ? items.filter((item) => {
            const start = timeOf(item.start)
            const end = timeOf(item.end)
            if (start === undefined && end === undefined) return true
            return (end ?? Number.NEGATIVE_INFINITY) > from
          })
        : []
    return { data: answered.length > 0 ? { items: answered } : {} }
  }
  return { runtime: { read } as unknown as Pick<Runtime, "read">, calls, fields }
}

/** A weekly meeting from 2026-10-19 until 2041: the shape that filled Memory with 2,610 future instances. */
function weekly(): Item[] {
  const items: Item[] = []
  const last = Date.parse("2041-12-31T00:00:00Z")
  for (let start = Date.parse("2026-10-19T10:00:00Z"); start <= last; start += 7 * DAY) {
    items.push({
      ...meeting(`weekly_${iso(start).slice(0, 10)}`, iso(start)),
      htmlLink: `https://www.google.com/calendar/event?eid=${iso(start).slice(0, 10)}`,
    })
  }
  return items
}

const list = (runtime: Pick<Runtime, "read">, request: Partial<EventsListRequest>, now: number) =>
  calendarEvents(runtime, ACCOUNT, { source: "calendar", ...request, limit: request.limit ?? 500 }, ctx, now)

const ids = (events: readonly SourceEvent[]) => events.map((event) => event.external_id)

/**
 * Google's answer, paged as Google pages a window: `maxResults` items from the `pageToken` offset, filtered by the
 * window (an item's end after `timeMin` and its start before `timeMax`; a tombstone without either is always answered),
 * with the next offset as the token. It records every call's params, and the item list is held by reference so a test
 * can change what Google has between calls.
 */
function pagedGoogle(items: readonly Item[], zone = "UTC") {
  const calls: Array<Record<string, unknown>> = []
  const read = async (request: { operation: string; params?: Record<string, unknown> }) => {
    if (request.operation === "calendar.calendarList.get") return { data: { id: CALENDAR, summary: "Sam Rivera", timeZone: zone } }
    const params = request.params ?? {}
    calls.push(params)
    const from = Date.parse(String(params["timeMin"] ?? "invalid"))
    const to = Date.parse(String(params["timeMax"] ?? "invalid"))
    const size = Number(params["maxResults"] ?? 100)
    const start = Number(params["pageToken"] ?? 0)
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(size) || size <= 0) throw new Error("the stub has no such page")
    const found = items.filter((item) => {
      const startAt = timeOf(item.start)
      const endAt = timeOf(item.end)
      if (startAt === undefined && endAt === undefined) return true
      return startAt !== undefined && endAt !== undefined && endAt > from && startAt < to
    })
    const page = found.slice(start, start + size)
    return { data: { ...(page.length > 0 ? { items: page } : {}), ...(start + size < found.length ? { nextPageToken: String(start + size) } : {}) } }
  }
  return { runtime: { read } as unknown as Pick<Runtime, "read">, calls }
}

describe("the calendar horizon", () => {
  it("never yields an instance a weekly series would place beyond now + 7 days", async () => {
    const items = weekly()
    expect(items.length).toBeGreaterThan(700)
    const { runtime, calls } = google(items)
    const result = await list(runtime, { since: Date.parse("2026-11-01T00:00:00Z") }, NOW)
    // Only the first instance is inside the window: the series continues past 2041 at Google.
    expect(ids(result.events)).toEqual(["weekly_2026-11-02"])
    expect(result.events.every((event) => Date.parse(event.occurred_at) <= NOW + HORIZON)).toBe(true)
    expect(calls[0]).toMatchObject({ showDeleted: true, singleEvents: true, timeMin: iso(Date.parse("2026-11-01T00:00:00Z")), timeMax: iso(NOW + HORIZON + 1) })
  })

  it("re-reads from the last run's time, so an instance entering the horizon arrives and a late run catches up", async () => {
    const { runtime, calls } = google(weekly())
    const first = await list(runtime, { since: Date.parse("2026-11-01T00:00:00Z") }, NOW)
    expect(ids(first.events)).toEqual(["weekly_2026-11-02"])
    // Two days later the 9 November instance is inside the new horizon; the window still covers the 2nd.
    const second = await list(runtime, { cursor: first.cursor }, NOW + 2 * DAY)
    expect(ids(second.events)).toEqual(["weekly_2026-11-02", "weekly_2026-11-09"])
    expect(calls[1]).toMatchObject({ timeMin: iso(NOW - HOUR), timeMax: iso(NOW + 2 * DAY + HORIZON + 1) })
  })

  it("keeps a cancellation inside the window, as a cancelled meeting", async () => {
    const { runtime, calls } = google([
      {
        id: "evt-cancelled",
        status: "cancelled",
        summary: "Cancelled standup",
        start: { dateTime: "2026-11-05T09:00:00Z" },
        end: { dateTime: "2026-11-05T09:30:00Z" },
        updated: "2026-11-01T08:00:00Z",
      },
      {
        id: "evt-cancelled-far",
        status: "cancelled",
        summary: "Cancelled in 2027",
        start: { dateTime: "2027-01-07T09:00:00Z" },
        end: { dateTime: "2027-01-07T09:30:00Z" },
        updated: "2026-11-01T08:00:00Z",
      },
    ])
    const result = await list(runtime, {}, NOW)
    expect(calls[0]).toMatchObject({ showDeleted: true, timeMax: iso(NOW + HORIZON + 1) })
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({ external_id: "evt-cancelled", occurred_at: "2026-11-01T08:00:00.000Z", kind: "meeting", labels: ["cancelled"], actors: [], text: "" })
  })

  it("refuses a cursor with a sync token and no checkpoint, and starts a fresh first window only from since", async () => {
    const digest = createHash("sha256").update(CALENDAR).digest("hex").slice(0, 16)
    const binding = { plugin: "gws", source: "calendar", account: ACCOUNT, scope: { calendars: ["primary"] } }
    const syncToken = encodeBoundCursor(binding, { a: ACCOUNT, o: digest, y: "CPDAlphabeticalSyncToken", w: 0, t: Date.parse("2040-12-31T00:00:00Z"), n: 0 })
    const { runtime, calls } = google(weekly())
    await expect(list(runtime, { cursor: syncToken }, NOW)).rejects.toThrow(/^CURSOR_INVALID:/)
    expect(calls).toHaveLength(0)
    const fresh = await list(runtime, {}, NOW)
    expect(calls[0]).toMatchObject({ timeMin: iso(NOW - FIRST_RUN), timeMax: iso(NOW + HORIZON + 1) })
    expect(fresh.gap).toBeUndefined()
    expect(ids(fresh.events)).toEqual(["weekly_2026-11-02"])
  })

  it("emits only kinds the declaration's reads name", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      capabilities: { sources: Array<{ id: string; reads: string | string[] }> }
    }
    const declared = pkg.capabilities.sources.find((item) => item.id === "gws.calendar")
    expect(declared?.reads).toBe("meeting")
    const reads = typeof declared?.reads === "string" ? [declared.reads] : (declared?.reads ?? [])
    const { runtime } = google([
      { id: "evt-confirmed", summary: "Plan", start: { dateTime: "2026-11-02T10:00:00Z" }, end: { dateTime: "2026-11-02T11:00:00Z" }, updated: "2026-10-28T09:00:00Z" },
      { id: "evt-cancelled", status: "cancelled", summary: "Lunch", start: { dateTime: "2026-11-03T12:00:00Z" }, end: { dateTime: "2026-11-03T13:00:00Z" }, updated: "2026-11-01T09:00:00Z" },
    ])
    const result = await list(runtime, {}, NOW)
    expect(result.events).toHaveLength(2)
    for (const event of result.events) expect(reads).toContain(event.kind)
  })
})

describe("a change after the last run", () => {
  it("lists a meeting created later for tomorrow", async () => {
    const items: Item[] = []
    const { runtime, calls } = google(items)
    const first = await list(runtime, { since: Date.parse("2026-11-01T00:00:00Z") }, NOW)
    expect(first.events).toEqual([])
    items.push(meeting("evt-created", "2026-11-02T10:00:00Z"))
    const second = await list(runtime, { cursor: first.cursor }, NOW + 2 * HOUR)
    expect(calls[1]).toMatchObject({ timeMin: iso(NOW - HOUR), timeMax: iso(NOW + 2 * HOUR + HORIZON + 1) })
    expect(ids(second.events)).toEqual(["evt-created"])
  })

  it("lists a meeting moved in from 2040", async () => {
    const items: Item[] = [meeting("evt-moved", "2040-12-31T10:00:00Z")]
    const { runtime } = google(items)
    const first = await list(runtime, { since: Date.parse("2026-11-01T00:00:00Z") }, NOW)
    expect(first.events).toEqual([])
    items[0] = meeting("evt-moved", "2026-11-02T10:00:00Z")
    const second = await list(runtime, { cursor: first.cursor }, NOW + HOUR)
    expect(ids(second.events)).toEqual(["evt-moved"])
  })

  it("lists a meeting cancelled after it was listed", async () => {
    const items: Item[] = [meeting("evt-later-cancelled", "2026-11-02T10:00:00Z")]
    const { runtime } = google(items)
    const first = await list(runtime, { since: Date.parse("2026-11-01T00:00:00Z") }, NOW)
    expect(first.events).toEqual([expect.objectContaining({ external_id: "evt-later-cancelled", labels: ["confirmed"] })])
    items[0] = meeting("evt-later-cancelled", "2026-11-02T10:00:00Z", { status: "cancelled", updated: "2026-11-01T12:00:00Z" })
    const second = await list(runtime, { cursor: first.cursor }, NOW + HOUR)
    expect(second.events).toEqual([expect.objectContaining({ external_id: "evt-later-cancelled", occurred_at: "2026-11-01T12:00:00.000Z", labels: ["cancelled"] })])
    expect(second.removals).toBeUndefined()
  })

  it("catches up after a late run, including a meeting created in the gap", async () => {
    const items: Item[] = []
    const { runtime, calls } = google(items)
    const first = await list(runtime, { since: Date.parse("2026-11-01T00:00:00Z") }, NOW)
    items.push(meeting("evt-gap", "2026-11-02T10:00:00Z"))
    const late = await list(runtime, { cursor: first.cursor }, NOW + 3 * DAY)
    expect(calls[1]).toMatchObject({ timeMin: iso(NOW - HOUR), timeMax: iso(NOW + 3 * DAY + HORIZON + 1) })
    expect(ids(late.events)).toEqual(["evt-gap"])
  })
})

describe("removals", () => {
  it("does not retract a whole recurring series that vanishes", async () => {
    const items: Item[] = [
      meeting("series_early", iso(NOW - 30 * 60 * 1000)),
      meeting("series_1", iso(NOW + 2 * HOUR)),
      meeting("series_2", iso(NOW + 2 * DAY)),
      meeting("series_3", iso(NOW + 5 * DAY)),
    ]
    const { runtime } = google(items)
    const first = await list(runtime, { since: NOW - HOUR }, NOW)
    expect(ids(first.events)).toEqual(["series_early", "series_1", "series_2", "series_3"])
    expect(first.removals).toBeUndefined()
    items.length = 0
    // A deleted series sends no instance under showDeleted and singleEvents; the gap is documented, not guessed at.
    const second = await list(runtime, { cursor: first.cursor }, NOW + 2 * HOUR)
    expect(second.events).toEqual([])
    expect(second.removals).toBeUndefined()
  })

  it("does not retract a meeting moved beyond seven days", async () => {
    const items: Item[] = [meeting("evt-moved-out", "2026-11-02T10:00:00Z")]
    const { runtime } = google(items)
    const first = await list(runtime, { since: Date.parse("2026-11-01T00:00:00Z") }, NOW)
    expect(ids(first.events)).toEqual(["evt-moved-out"])
    items[0] = meeting("evt-moved-out", "2040-12-31T10:00:00Z")
    const second = await list(runtime, { cursor: first.cursor }, NOW + HOUR)
    expect(second.events).toEqual([])
    // Absent from the window is not deleted: Memory must keep the meeting, not lose it for up to a week.
    expect(second.removals).toBeUndefined()
  })

  it("retracts a cancelled event Google answers without a start", async () => {
    const { runtime } = google([{ id: "evt-no-start", status: "cancelled", summary: "Gone", updated: "2026-11-01T10:00:00Z" }])
    const result = await list(runtime, {}, NOW)
    expect(result.events).toEqual([])
    expect(result.removals).toEqual([{ external_id: "evt-no-start", at: iso(NOW), reason: "deleted" }])
  })
})

describe("the window", () => {
  it("returns no events and a valid cursor for a window with no meetings", async () => {
    const { runtime, calls } = google([])
    const first = await list(runtime, {}, NOW)
    expect(first.events).toEqual([])
    expect(first.more).toBe(false)
    expect(first.cursor.length).toBeLessThan(200)
    const second = await list(runtime, { cursor: first.cursor }, NOW + HOUR)
    expect(second.events).toEqual([])
    expect(second.more).toBe(false)
    expect(calls).toHaveLength(2)
  })

  it("treats a since in the future as now, not a one-millisecond window", async () => {
    const { runtime, calls } = google([])
    const result = await list(runtime, { since: Date.parse("2027-06-01T00:00:00Z") }, NOW)
    expect(calls[0]).toMatchObject({ timeMin: iso(NOW), timeMax: iso(NOW + HORIZON + 1) })
    expect(result.events).toEqual([])
  })

  it("keeps the cursor small with many meetings in the window", async () => {
    const items = Array.from({ length: 60 }, (_, index) =>
      meeting(`evt_many_${String(index).padStart(2, "0")}_20261120T100000Z`, iso(NOW + (index + 1) * HOUR)),
    )
    const { runtime } = google(items)
    const first = await list(runtime, { since: NOW - HOUR }, NOW)
    expect(first.events).toHaveLength(60)
    expect(first.cursor.length).toBeLessThan(200)
    expect(first.cursor.length).toBeLessThanOrEqual(1024)
    const decoded = decodeBoundCursor({ plugin: "gws", source: "calendar", account: ACCOUNT, scope: { calendars: ["primary"] } }, first.cursor)
    expect(decoded.ok).toBe(true)
    // The cursor is the window state only: no list of ids for a removal guess.
    if (decoded.ok) expect(decoded.state["k"]).toBeUndefined()
    // It still resumes: the next run reads the same window and lists every meeting.
    const second = await list(runtime, { cursor: first.cursor }, NOW + HOUR)
    expect(second.events).toHaveLength(60)
    expect(second.cursor.length).toBeLessThan(200)
  })

  it("refuses a cursor with no window and no opening time, so the next call starts from since", async () => {
    const digest = createHash("sha256").update(CALENDAR).digest("hex").slice(0, 16)
    const binding = { plugin: "gws", source: "calendar", account: ACCOUNT, scope: { calendars: ["primary"] } }
    const bare = encodeBoundCursor(binding, { a: ACCOUNT, o: digest, g: 1, n: 0 })
    const { runtime, calls } = google([meeting("evt-in-window", iso(NOW - HOUR))])
    await expect(list(runtime, { cursor: bare, since: Date.parse("2020-01-01T00:00:00Z") }, NOW)).rejects.toThrow(/^CURSOR_INVALID:/)
    expect(calls).toHaveLength(0)
    // Without a cursor, since starts the window; only a fresh call with no since starts the first run's 24 hours.
    const fresh = await list(runtime, { since: Date.parse("2020-01-01T00:00:00Z") }, NOW)
    expect(calls[0]).toMatchObject({ timeMin: iso(Date.parse("2020-01-01T00:00:00Z")), timeMax: iso(NOW + HORIZON + 1) })
    expect(ids(fresh.events)).toEqual(["evt-in-window"])
  })
})

describe("the cursor binding", () => {
  it("refuses a cursor another account or calendar issued", async () => {
    const { runtime } = google([])
    const digest = createHash("sha256").update(CALENDAR).digest("hex").slice(0, 16)
    const foreignAccount = encodeBoundCursor(
      { plugin: "gws", source: "calendar", account: "work", scope: { calendars: ["primary"] } },
      { a: "work", o: digest, r: NOW },
    )
    await expect(list(runtime, { cursor: foreignAccount }, NOW)).rejects.toThrow(/^CURSOR_INVALID: /)
    const foreignCalendar = encodeBoundCursor(
      { plugin: "gws", source: "calendar", account: ACCOUNT, scope: { calendars: ["primary"] } },
      { a: ACCOUNT, o: "0".repeat(16), r: NOW },
    )
    await expect(list(runtime, { cursor: foreignCalendar }, NOW)).rejects.toThrow(/^CURSOR_INVALID: /)
  })
})

describe("a window drained over several calls", () => {
  it("freezes its cutoff, and the next window overlaps from when it opened, not from its last page", async () => {
    const items: Item[] = [
      meeting("evt-a", iso(NOW + HOUR)),
      meeting("evt-b", iso(NOW + 2 * HOUR)),
      meeting("evt-c", iso(NOW + 3 * HOUR)),
      meeting("evt-d", iso(NOW + 4 * HOUR)),
      meeting("evt-e", iso(NOW + 5 * HOUR)),
    ]
    const { runtime, calls } = pagedGoogle(items)
    const first = await list(runtime, { since: NOW - HOUR, limit: 1 }, NOW)
    expect(ids(first.events)).toEqual(["evt-a"])
    expect(first.more).toBe(true)
    // A meeting created while the drain is running sorts before the place it has already read: the page key changed.
    items.push(meeting("evt-late", iso(NOW + 30 * MINUTE)))
    const second = await list(runtime, { cursor: first.cursor, limit: 500 }, NOW + 2 * DAY)
    // The changed page is not resumed at its old offset: an empty restart page re-reads the saved window, no progress.
    expect(second.events).toEqual([])
    expect(second.more).toBe(true)
    expect(calls[1]).toMatchObject({ timeMin: iso(NOW - HOUR), timeMax: iso(NOW + HORIZON + 1) })
    const restarted = decodeBoundCursor({ plugin: "gws", source: "calendar", account: ACCOUNT, scope: { calendars: ["primary"] } }, second.cursor)
    expect(restarted.ok && restarted.state["n"]).toBe(0)
    expect(restarted.ok && restarted.state["c"]).toBe(1)
    // The restart reads from the window's lower bound and includes the late meeting, at the cost of repeating what it had.
    const third = await list(runtime, { cursor: second.cursor, limit: 500 }, NOW + 2 * DAY)
    expect(ids(third.events)).toEqual(["evt-late", "evt-a", "evt-b", "evt-c", "evt-d", "evt-e"])
    expect(third.more).toBe(false)
    expect(calls[2]).toMatchObject({ timeMin: iso(NOW - HOUR), timeMax: iso(NOW + HORIZON + 1) })
    const decoded = decodeBoundCursor({ plugin: "gws", source: "calendar", account: ACCOUNT, scope: { calendars: ["primary"] } }, third.cursor)
    expect(decoded.ok && decoded.state["r"]).toBe(NOW)
    // The drained window keeps the bounds it opened with; the next window starts an hour before the drain opened.
    const fourth = await list(runtime, { cursor: third.cursor }, NOW + 2 * DAY + HOUR)
    expect(calls[3]).toMatchObject({ timeMin: iso(NOW - HOUR), timeMax: iso(NOW + 2 * DAY + HOUR + HORIZON + 1) })
    expect(ids(fourth.events)).toContain("evt-late")
  })

  it("keeps the provider page size stable when a later call asks for another limit", async () => {
    const items = Array.from({ length: 100 }, (_, index) =>
      meeting(`evt_${String(index).padStart(3, "0")}`, iso(NOW + (index + 1) * MINUTE), { description: "x".repeat(5000) }),
    )
    const { runtime, calls } = pagedGoogle(items)
    const first = await list(runtime, { since: NOW - HOUR, limit: 70 }, NOW)
    // The byte cap trims inside the first provider page, so the cursor saves an in-page index.
    expect(first.events.length).toBeLessThan(70)
    expect(first.more).toBe(true)
    expect(calls[0]).toMatchObject({ maxResults: 100 })
    const seen = ids(first.events)
    let page = first
    let guard = 0
    while (page.more && guard++ < 10) {
      page = await list(runtime, { cursor: page.cursor, limit: 500 }, NOW + guard * MINUTE)
      seen.push(...ids(page.events))
    }
    // A page re-read at the same size keeps the saved index: the changed request limit neither skips nor repeats an event.
    expect(calls.slice(1).map((call) => call["maxResults"])).toEqual([100])
    expect(seen).toHaveLength(100)
    expect(new Set(seen).size).toBe(100)
  })
})

describe("removals in the consumed prefix", () => {
  it("answers a removal once, at the time Google reported, and never past the prefix", async () => {
    const items: Item[] = [
      meeting("evt-a", iso(NOW + HOUR)),
      { id: "evt-gone", status: "cancelled", summary: "Gone", updated: "2026-10-31T09:00:00Z" },
      meeting("evt-b", iso(NOW + 2 * HOUR)),
    ]
    const { runtime } = pagedGoogle(items)
    const first = await list(runtime, { since: NOW - HOUR, limit: 1 }, NOW)
    expect(ids(first.events)).toEqual(["evt-a"])
    expect(first.removals).toEqual([{ external_id: "evt-gone", at: "2026-10-31T09:00:00.000Z", reason: "deleted" }])
    expect(first.more).toBe(true)
    const second = await list(runtime, { cursor: first.cursor, limit: 1 }, NOW + HOUR)
    expect(ids(second.events)).toEqual(["evt-b"])
    // The tombstone was in the first page's prefix; it is not answered again with the next call's time.
    expect(second.removals).toBeUndefined()
    // A fresh window that reads the same tombstone names the same time.
    const again = await list(runtime, { since: NOW - HOUR, limit: 1 }, NOW + 2 * HOUR)
    expect(again.removals).toEqual(first.removals)
  })

  it("budgets a removal-only page and resumes without repeating one", async () => {
    const items: Item[] = Array.from({ length: 500 }, (_, index) => ({
      id: `gone_${"r".repeat(500)}${String(index).padStart(3, "0")}`,
      status: "cancelled",
      updated: iso(NOW - HOUR - index * 1000),
    }))
    const { runtime } = pagedGoogle(items)
    const first = await list(runtime, { since: NOW - HOUR, limit: 1 }, NOW)
    expect(first.events).toEqual([])
    expect(first.removals!.length).toBeGreaterThan(400)
    expect(first.removals!.length).toBeLessThan(500)
    expect(first.more).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(262144)
    expect(resultProblems(first, 1, 262144)).toEqual([])
    const second = await list(runtime, { cursor: first.cursor, limit: 1 }, NOW + HOUR)
    const all = [...first.removals!, ...(second.removals ?? [])]
    expect(all).toHaveLength(500)
    expect(new Set(all.map((entry) => entry.external_id)).size).toBe(500)
    expect(new Set(all.map((entry) => entry.at)).size).toBe(500)
    expect(second.more).toBe(false)
    expect(resultProblems(second, 1, 262144)).toEqual([])
  })

  it("gives a dense mixed page one budget and one prefix", async () => {
    const items: Item[] = []
    for (let index = 0; index < 120; index++) {
      items.push(meeting(`evt_${String(index).padStart(3, "0")}`, iso(NOW + (index + 1) * MINUTE), { description: "x".repeat(5000) }))
      if (index % 3 === 0) items.push({ id: `gone_${String(index).padStart(3, "0")}`, status: "cancelled", updated: iso(NOW - HOUR - index * 1000) })
      if (index % 4 === 0) {
        items.push(meeting(`secret_${String(index).padStart(3, "0")}`, iso(NOW + (index + 1) * MINUTE + 30_000), { description: "The guest wifi password: Ku7pLm2QzR9w" }))
      }
    }
    const { runtime } = pagedGoogle(items)
    const seen: string[] = []
    const refused = new Set<string>()
    const removals = new Map<string, string>()
    let page = await list(runtime, { since: NOW - HOUR, limit: 500 }, NOW)
    let guard = 0
    for (;;) {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(262144)
      expect(resultProblems(page, 500, 262144)).toEqual([])
      seen.push(...ids(page.events))
      for (const entry of page.refused ?? []) refused.add(entry.external_id)
      for (const entry of page.removals ?? []) {
        const known = removals.get(entry.external_id)
        if (known !== undefined) expect(entry.at).toBe(known)
        removals.set(entry.external_id, entry.at)
      }
      if (!page.more) break
      if (guard++ > 40) throw new Error("the walk did not end")
      page = await list(runtime, { cursor: page.cursor, limit: 500 }, NOW + (guard + 1) * HOUR)
    }
    expect(seen).toHaveLength(120)
    expect(new Set(seen).size).toBe(120)
    expect(refused.size).toBe(30)
    expect(removals.size).toBe(40)
  })
})

describe("page identity and drift", () => {
  it("breaks a same-time tie by external_id, so a provider reorder cannot skip an item", async () => {
    const at = iso(NOW + HOUR)
    const items: Item[] = [meeting("evt_a", at), meeting("evt_b", at)]
    const { runtime } = pagedGoogle(items)
    const first = await list(runtime, { since: NOW - HOUR, limit: 1 }, NOW)
    expect(ids(first.events)).toEqual(["evt_a"])
    expect(first.more).toBe(true)
    // The provider answers the same two items in the other order; the stable tie-break keeps the cursor's place.
    items.reverse()
    const second = await list(runtime, { cursor: first.cursor, limit: 500 }, NOW + MINUTE)
    expect(ids(second.events)).toEqual(["evt_b"])
    expect(second.more).toBe(false)
  })

  it("restarts a page whose membership changed instead of reusing its offset", async () => {
    const items: Item[] = [
      meeting("evt_a", iso(NOW - 3 * HOUR)),
      meeting("evt_b", iso(NOW - 2.5 * HOUR)),
      meeting("evt_c", iso(NOW + HOUR)),
    ]
    const { runtime } = pagedGoogle(items)
    const first = await list(runtime, { since: NOW - 4 * HOUR, limit: 1 }, NOW)
    expect(ids(first.events)).toEqual(["evt_a"])
    // A vanishes: B shifts into the offset the cursor had already passed, so reusing it would skip B for good.
    items.shift()
    const second = await list(runtime, { cursor: first.cursor, limit: 500 }, NOW)
    expect(second.events).toEqual([])
    expect(second.more).toBe(true)
    expect(resultProblems(second)).toEqual([])
    const restart = decodeBoundCursor(BINDING, second.cursor)
    expect(restart.ok && restart.state["n"]).toBe(0)
    expect(restart.ok && restart.state["c"]).toBe(1)
    const third = await list(runtime, { cursor: second.cursor, limit: 500 }, NOW)
    expect(ids(third.events)).toEqual(["evt_b", "evt_c"])
    expect(third.more).toBe(false)
  })

  it("fails after a bounded number of page restarts instead of looping or skipping", async () => {
    const items: Item[] = [meeting("evt_a", iso(NOW - 2 * HOUR)), meeting("evt_b", iso(NOW - HOUR))]
    const { runtime } = pagedGoogle(items)
    const first = await list(runtime, { since: NOW - 3 * HOUR, limit: 1 }, NOW)
    expect(ids(first.events)).toEqual(["evt_a"])
    // Every resume sees another update time on B: each changed page restarts, up to the bound, then fails.
    items[1] = meeting("evt_b", iso(NOW - HOUR), { updated: iso(NOW) })
    const second = await list(runtime, { cursor: first.cursor, limit: 1 }, NOW)
    expect(second.events).toEqual([])
    const third = await list(runtime, { cursor: second.cursor, limit: 1 }, NOW)
    expect(ids(third.events)).toEqual(["evt_a"])
    items[1] = meeting("evt_b", iso(NOW - HOUR), { updated: iso(NOW + MINUTE) })
    const fourth = await list(runtime, { cursor: third.cursor, limit: 1 }, NOW)
    expect(fourth.events).toEqual([])
    const fifth = await list(runtime, { cursor: fourth.cursor, limit: 1 }, NOW)
    expect(ids(fifth.events)).toEqual(["evt_a"])
    items[1] = meeting("evt_b", iso(NOW - HOUR), { updated: iso(NOW + 2 * MINUTE) })
    await expect(list(runtime, { cursor: fifth.cursor, limit: 1 }, NOW)).rejects.toThrow(/^GWS_API_ERROR: The calendar changed the same page/)
  })
})

describe("cursor checkpoints", () => {
  it("tags a resumed page with a version and a bounded fingerprint", async () => {
    const at = iso(NOW + HOUR)
    const { runtime } = pagedGoogle([meeting("evt_a", at), meeting("evt_b", at)])
    const first = await list(runtime, { since: NOW - HOUR, limit: 1 }, NOW)
    const decoded = decodeBoundCursor(BINDING, first.cursor)
    expect(decoded.ok && decoded.state["g"]).toBe(1)
    expect(decoded.ok && decoded.state["n"]).toBe(1)
    expect(decoded.ok && decoded.state["f"]).toMatch(/^[0-9a-f]{32}$/)
  })

  it("refuses a cursor without the checkpoint version, and one whose intra-page offset has no fingerprint", async () => {
    const digest = createHash("sha256").update(CALENDAR).digest("hex").slice(0, 16)
    const unversioned = encodeBoundCursor(BINDING, { a: ACCOUNT, o: digest, w: NOW - 4 * HOUR, x: NOW + HORIZON + 1, i: NOW, p: "0", n: 1 })
    const noFingerprint = encodeBoundCursor(BINDING, { a: ACCOUNT, o: digest, g: 1, w: NOW - HOUR, x: NOW + HORIZON + 1, i: NOW, n: 1 })
    const { runtime, calls } = pagedGoogle([meeting("evt_a", iso(NOW - 3 * HOUR))])
    for (const cursor of [unversioned, noFingerprint]) await expect(list(runtime, { cursor }, NOW)).rejects.toThrow(/^CURSOR_INVALID:/)
    expect(calls).toHaveLength(0)
  })

  it("starts the window after a finished cursor an hour before the time it opened", async () => {
    const digest = createHash("sha256").update(CALENDAR).digest("hex").slice(0, 16)
    const finished = encodeBoundCursor(BINDING, { a: ACCOUNT, o: digest, g: 1, r: NOW })
    const { runtime, calls } = pagedGoogle([])
    const next = await list(runtime, { cursor: finished }, NOW + HOUR)
    expect(calls[0]).toMatchObject({ timeMin: iso(NOW - HOUR), timeMax: iso(NOW + HOUR + HORIZON + 1) })
    expect(next.events).toEqual([])
  })

  it("refuses another checkpoint version, a malformed fingerprint and an over-bound restart count", async () => {
    const digest = createHash("sha256").update(CALENDAR).digest("hex").slice(0, 16)
    const { runtime } = pagedGoogle([])
    const state = { a: ACCOUNT, o: digest, w: NOW - HOUR, x: NOW + HORIZON + 1, i: NOW, n: 0 }
    await expect(list(runtime, { cursor: encodeBoundCursor(BINDING, { ...state, g: 2 }) }, NOW)).rejects.toThrow(/^CURSOR_INVALID: /)
    await expect(list(runtime, { cursor: encodeBoundCursor(BINDING, { ...state, g: 1, f: "not-a-fingerprint", n: 1 }) }, NOW)).rejects.toThrow(/^CURSOR_INVALID: /)
    await expect(list(runtime, { cursor: encodeBoundCursor(BINDING, { ...state, g: 1, c: 3 }) }, NOW)).rejects.toThrow(/^CURSOR_INVALID: /)
  })
})

describe("removal identity and observation times", () => {
  it("repeats a stable provider time across windows and names missing or future updates honestly", async () => {
    const items: Item[] = [
      { id: "stable_gone", status: "cancelled", updated: iso(NOW - 2 * HOUR) },
      { id: "missing_gone", status: "cancelled" },
      { id: "future_gone", status: "cancelled", updated: iso(NOW + 10 * HOUR) },
    ]
    const { runtime } = google(items)
    const first = await list(runtime, { since: NOW - 4 * HOUR }, NOW)
    expect(first.removals).toEqual([
      { external_id: "stable_gone", at: iso(NOW - 2 * HOUR), reason: "deleted" },
      { external_id: "future_gone", at: iso(NOW), reason: "deleted" },
      { external_id: "missing_gone", at: iso(NOW), reason: "deleted" },
    ])
    expect(resultProblems(first)).toEqual([])
    // A later window: the stable time repeats, the missing one names that window's opening time, and the future
    // update is now in the past so its provider time can be used; none is later than asOf.
    const second = await list(runtime, { since: NOW - 4 * HOUR }, NOW + 2 * DAY)
    expect(second.removals).toEqual([
      { external_id: "stable_gone", at: iso(NOW - 2 * HOUR), reason: "deleted" },
      { external_id: "future_gone", at: iso(NOW + 10 * HOUR), reason: "deleted" },
      { external_id: "missing_gone", at: iso(NOW + 2 * DAY), reason: "deleted" },
    ])
    expect(resultProblems(second)).toEqual([])
  })

  it("drops only an exact duplicate within one response, and allows an event and a removal with the same id", async () => {
    const items: Item[] = [
      { id: "dup_gone", status: "cancelled", updated: iso(NOW - 2 * HOUR) },
      { id: "dup_gone", status: "cancelled", updated: iso(NOW - 2 * HOUR) },
      meeting("dup_event", iso(NOW + HOUR)),
      meeting("dup_event", iso(NOW + HOUR)),
      { id: "same", status: "cancelled", updated: iso(NOW - HOUR) },
      meeting("same", iso(NOW + 2 * HOUR)),
    ]
    const { runtime } = google(items)
    const result = await list(runtime, { since: NOW - 4 * HOUR }, NOW)
    expect(ids(result.events)).toEqual(["dup_event", "same"])
    expect(result.removals).toEqual([
      { external_id: "dup_gone", at: iso(NOW - 2 * HOUR), reason: "deleted" },
      { external_id: "same", at: iso(NOW - HOUR), reason: "deleted" },
    ])
    expect(resultProblems(result)).toEqual([])
  })

  it("restarts on two versions of one id in a response instead of discarding the later one", async () => {
    const items: Item[] = [
      meeting("evt_x", iso(NOW + HOUR), { summary: "v1", updated: iso(NOW) }),
      meeting("evt_x", iso(NOW + HOUR), { summary: "v2", updated: iso(NOW + MINUTE) }),
    ]
    const { runtime } = google(items)
    const first = await list(runtime, { since: NOW - 4 * HOUR }, NOW)
    expect(first.events).toEqual([])
    expect(first.more).toBe(true)
    const restart = decodeBoundCursor(BINDING, first.cursor)
    expect(restart.ok && restart.state["c"]).toBe(1)
    // The provider now returns the newer version alone; the restart surfaces it rather than keeping the old one.
    items.splice(0, 1)
    const second = await list(runtime, { cursor: first.cursor }, NOW)
    expect(second.events).toHaveLength(1)
    expect(second.events[0]).toMatchObject({ external_id: "evt_x", title: "v2" })
  })

  it("fails after a bounded number of conflicting versions instead of dropping one", async () => {
    const items: Item[] = [meeting("evt_x", iso(NOW + HOUR), { summary: "v1", updated: iso(NOW) }), meeting("evt_x", iso(NOW + HOUR), { summary: "v2", updated: iso(NOW + MINUTE) })]
    const { runtime } = google(items)
    const first = await list(runtime, { since: NOW - 4 * HOUR }, NOW)
    expect(first.events).toEqual([])
    const second = await list(runtime, { cursor: first.cursor }, NOW)
    expect(second.events).toEqual([])
    // Two restarts are allowed in a window; the third conflict fails explicitly.
    await expect(list(runtime, { cursor: second.cursor }, NOW)).rejects.toThrow(/^GWS_API_ERROR: The calendar returned two versions/)
  })

  it("surfaces a later newer version that arrives after the cursor, even with the same updated time", async () => {
    const items: Item[] = [meeting("evt_a", iso(NOW + HOUR)), meeting("evt_x", iso(NOW + 2 * HOUR), { summary: "v1" })]
    const { runtime } = pagedGoogle(items)
    const first = await list(runtime, { since: NOW - 4 * HOUR, limit: 1 }, NOW)
    expect(ids(first.events)).toEqual(["evt_a"])
    items[1] = meeting("evt_x", iso(NOW + 2 * HOUR), { summary: "v2" })
    const second = await list(runtime, { cursor: first.cursor, limit: 500 }, NOW)
    expect(ids(second.events)).toEqual(["evt_x"])
    expect(second.events[0]).toMatchObject({ external_id: "evt_x", title: "v2" })
  })
})

describe("oversized provider ids", () => {
  const base32hex = "0123456789abcdefghijklmnopqrstuv"
  const long = (seed: string) => (seed + base32hex.repeat(40)).slice(0, 1024)
  const mapped = (id: string) => `sha256:${createHash("sha256").update(id).digest("hex")}`

  it("maps a 1024-character base32hex id for an event, a refusal and a removal, and keeps an in-limit id", async () => {
    const longEvent = long("a")
    const longSecret = long("b")
    const longGone = long("c")
    expect(longEvent).toMatch(/^[0-9a-v]{1024}$/)
    // `calendar.today`'s 128-character cap and events_list's 512-character cap share one mapping for an id over both.
    expect(stableEventId(longEvent, 512)).toBe(stableEventId(longEvent, 128))
    expect(stableEventId(longEvent, 512)).toBe(mapped(longEvent))
    const items: Item[] = [
      meeting(longEvent, iso(NOW + HOUR)),
      meeting(longSecret, iso(NOW + 2 * HOUR), { description: "The guest wifi password: Ku7pLm2QzR9w" }),
      { id: longGone, status: "cancelled", updated: iso(NOW - HOUR) },
      meeting("a".repeat(512), iso(NOW + 3 * HOUR)),
    ]
    const { runtime } = google(items)
    const result = await list(runtime, { since: NOW - HOUR }, NOW)
    expect(ids(result.events)).toEqual([mapped(longEvent), "a".repeat(512)])
    expect(result.refused).toEqual([{ external_id: mapped(longSecret), reason: "secret", detail: "holds a secret (password)" }])
    expect(result.removals).toEqual([{ external_id: mapped(longGone), at: iso(NOW - HOUR), reason: "deleted" }])
    for (const id of [mapped(longEvent), mapped(longSecret), mapped(longGone)]) {
      expect(id).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(id.length).toBeLessThanOrEqual(512)
      // The reserved prefix's `:` is outside the provider's base32hex alphabet, so no provider id can collide with it.
      expect(id).not.toMatch(/^[0-9a-v]+$/)
      expect(longEvent.startsWith(id)).toBe(false)
    }
    expect(resultProblems(result)).toEqual([])
    // A later removal for the same long provider id names the same external_id the event used.
    const listed = ids(result.events)[0]!
    items[0] = { id: longEvent, status: "cancelled", updated: iso(NOW - MINUTE) }
    const second = await list(runtime, { since: NOW - HOUR }, NOW + HOUR)
    expect(second.removals).toContainEqual({ external_id: listed, at: iso(NOW - MINUTE), reason: "deleted" })
    expect(resultProblems(second)).toEqual([])
  })
})

describe("recurrence markers and cancellation distinctions", () => {
  it("keeps a cancelled instance with a start as a meeting and a marker-only cancellation as a removal", async () => {
    const items: Item[] = [
      meeting("series_series", iso(NOW + HOUR), { recurringEventId: "series", originalStartTime: { dateTime: iso(NOW + HOUR) } }),
      meeting("series_cancelled", iso(NOW + 2 * HOUR), {
        status: "cancelled",
        updated: iso(NOW - HOUR),
        recurringEventId: "series",
        originalStartTime: { dateTime: iso(NOW + 2 * HOUR) },
      }),
      { id: "series_gone", status: "cancelled", recurringEventId: "series", originalStartTime: { dateTime: iso(NOW - 2 * HOUR) } },
      { id: "future_original_gone", status: "cancelled", updated: iso(NOW + 2 * HOUR), originalStartTime: { dateTime: iso(NOW - 2 * HOUR) } },
      { id: "plain_gone", status: "cancelled", updated: iso(NOW - 3 * HOUR) },
      { id: "future_gone", status: "cancelled", updated: iso(NOW + 2 * HOUR) },
      { id: "missing_gone", status: "cancelled" },
      meeting("plain_confirmed", iso(NOW + 3 * HOUR)),
      { id: "confirmed_no_start", status: "confirmed", recurringEventId: "series" },
    ]
    const { runtime, fields } = google(items)
    const result = await list(runtime, { since: NOW - 4 * HOUR }, NOW)
    expect(fields[0]).toContain("recurringEventId")
    expect(fields[0]).toContain("originalStartTime")
    expect(ids(result.events)).toEqual(["series_cancelled", "series_series", "plain_confirmed"])
    expect(result.events[0]).toMatchObject({ external_id: "series_cancelled", labels: ["cancelled"], actors: [], text: "" })
    expect(result.events[1]).toMatchObject({ external_id: "series_series", labels: ["confirmed"] })
    // A cancelled instance with a start is not retracted; a confirmed marker-only instance is not an outcome at all.
    expect(result.removals?.map((entry) => entry.external_id)).not.toContain("series_cancelled")
    // A recurring slot is never the removal time: with no usable updated, every one names the window's opening time.
    expect(result.removals).toEqual([
      { external_id: "plain_gone", at: iso(NOW - 3 * HOUR), reason: "deleted" },
      { external_id: "future_gone", at: iso(NOW), reason: "deleted" },
      { external_id: "future_original_gone", at: iso(NOW), reason: "deleted" },
      { external_id: "missing_gone", at: iso(NOW), reason: "deleted" },
      { external_id: "series_gone", at: iso(NOW), reason: "deleted" },
    ])
    expect(resultProblems(result)).toEqual([])
  })
})

describe("the persisted window bound", () => {
  it("filters an over-answering provider by the window's timeMax, not by a later call's horizon", async () => {
    const items: Item[] = [
      meeting("evt_a", iso(NOW + HOUR)),
      meeting("evt_b", iso(NOW + 2 * HOUR)),
      meeting("evt_edge", iso(NOW + HORIZON)),
      meeting("evt_past_edge", iso(NOW + HORIZON + 1)),
    ]
    // This stub over-answers past timeMax on purpose; the source's own persisted bound is what the test holds.
    const { runtime, calls } = google(items)
    const first = await list(runtime, { since: NOW - HOUR, limit: 1 }, NOW)
    expect(ids(first.events)).toEqual(["evt_a"])
    expect(calls[0]).toMatchObject({ timeMax: iso(NOW + HORIZON + 1) })
    const second = await list(runtime, { cursor: first.cursor, limit: 500 }, NOW + 2 * DAY)
    // The instance at x - 1 is kept; the one at x is out even though a horizon from the new now would include it.
    expect(ids(second.events)).toEqual(["evt_b", "evt_edge"])
    expect(calls[1]).toMatchObject({ timeMax: iso(NOW + HORIZON + 1) })
  })
})

describe("provider page boundaries", () => {
  it("verifies the prior page before trusting a boundary token, so a removed emitted row cannot skip the last unseen row", async () => {
    const items = Array.from({ length: 101 }, (_, index) => meeting(`evt_${String(index).padStart(3, "0")}`, iso(NOW + (index + 1) * MINUTE)))
    const { runtime } = pagedGoogle(items)
    const first = await list(runtime, { since: NOW - HOUR, limit: 100 }, NOW)
    expect(first.events).toHaveLength(100)
    const boundary = decodeBoundCursor(BINDING, first.cursor)
    expect(boundary.ok && boundary.state["n"]).toBe(0)
    expect(boundary.ok && boundary.state["p"]).toBeUndefined()
    expect(boundary.ok && boundary.state["q"]).toBeUndefined()
    expect(boundary.ok && typeof boundary.state["f"]).toBe("string")
    expect(boundary.ok && typeof boundary.state["h"]).toBe("string")
    // An emitted row is removed; the offset token now points past the formerly last, unseen row.
    items.shift()
    const second = await list(runtime, { cursor: first.cursor, limit: 500 }, NOW)
    expect(second.events).toEqual([])
    expect(second.more).toBe(true)
    expect(resultProblems(second)).toEqual([])
    // The restart re-reads the saved window and surfaces the formerly unseen row; a raw offset would have lost it.
    const third = await list(runtime, { cursor: second.cursor, limit: 500 }, NOW)
    expect(ids(third.events)).toHaveLength(100)
    expect(ids(third.events)).toContain("evt_100")
  })
})

describe("tokens, dates and progress", () => {
  it("emits and accepts a 513-character provider page token", async () => {
    const token = "t".repeat(513)
    const page0 = [meeting("evt_a", iso(NOW + HOUR))]
    const page1 = [meeting("evt_b", iso(NOW + 2 * HOUR))]
    const calls: Array<Record<string, unknown>> = []
    const read = async (request: { operation: string; params?: Record<string, unknown> }) => {
      if (request.operation === "calendar.calendarList.get") return { data: { id: CALENDAR, summary: "Sam Rivera", timeZone: "UTC" } }
      const params = request.params ?? {}
      calls.push(params)
      return { data: params["pageToken"] === token ? { items: page1 } : { items: page0, nextPageToken: token } }
    }
    const runtime = { read } as unknown as Pick<Runtime, "read">
    const first = await list(runtime, { since: NOW - HOUR, limit: 1 }, NOW)
    expect(ids(first.events)).toEqual(["evt_a"])
    const decoded = decodeBoundCursor(BINDING, first.cursor)
    expect(decoded.ok && decoded.state["p"]).toBeUndefined()
    expect(decoded.ok && decoded.state["h"]).toBe(createHash("sha256").update(token).digest("hex").slice(0, 32))
    expect(first.cursor.length).toBeLessThanOrEqual(1024)
    // The next call reads the cursor this code emitted; the prior page is verified first, then the token page.
    const second = await list(runtime, { cursor: first.cursor, limit: 500 }, NOW)
    expect(ids(second.events)).toEqual(["evt_b"])
    expect(calls[1]).not.toHaveProperty("pageToken")
    expect(calls[2]).toMatchObject({ pageToken: token })
  })

  it("fails clearly on a page token too long to checkpoint, rather than emitting a self-rejected cursor", async () => {
    const token = "t".repeat(901)
    const read = async (request: { operation: string; params?: Record<string, unknown> }) => {
      if (request.operation === "calendar.calendarList.get") return { data: { id: CALENDAR, summary: "Sam Rivera", timeZone: "UTC" } }
      return { data: { items: [meeting("evt_a", iso(NOW + HOUR))], nextPageToken: token } }
    }
    const runtime = { read } as unknown as Pick<Runtime, "read">
    await expect(list(runtime, { since: NOW - HOUR }, NOW)).rejects.toThrow(/^GWS_API_ERROR: The calendar's page token is too long/)
  })

  it("fails clearly on a repeated page token instead of stalling with more", async () => {
    const read = async (request: { operation: string; params?: Record<string, unknown> }) => {
      if (request.operation === "calendar.calendarList.get") return { data: { id: CALENDAR, summary: "Sam Rivera", timeZone: "UTC" } }
      const params = request.params ?? {}
      return { data: params["pageToken"] === "loop" ? { items: [meeting("evt_b", iso(NOW + 2 * HOUR))], nextPageToken: "loop" } : { items: [meeting("evt_a", iso(NOW + HOUR))], nextPageToken: "loop" } }
    }
    const runtime = { read } as unknown as Pick<Runtime, "read">
    await expect(list(runtime, { since: NOW - HOUR }, NOW)).rejects.toThrow(/^GWS_API_ERROR: The calendar repeated a page token/)
  })

  it("refuses an out-of-range cursor time with CURSOR_INVALID instead of RangeError", async () => {
    const digest = createHash("sha256").update(CALENDAR).digest("hex").slice(0, 16)
    const huge = 8_640_000_000_000_001
    const base = { a: ACCOUNT, o: digest, g: 1, n: 0 }
    const { runtime } = google([])
    await expect(list(runtime, { cursor: encodeBoundCursor(BINDING, { ...base, w: 0, x: huge, i: 0 }) }, NOW)).rejects.toThrow(/^CURSOR_INVALID: /)
    await expect(list(runtime, { cursor: encodeBoundCursor(BINDING, { ...base, w: 0, x: NOW, i: huge }) }, NOW)).rejects.toThrow(/^CURSOR_INVALID: /)
    await expect(list(runtime, { cursor: encodeBoundCursor(BINDING, { ...base, r: huge }) }, NOW)).rejects.toThrow(/^CURSOR_INVALID: /)
  })
})

describe("clock regression and the calendar zone", () => {
  it("caps a removal at this call's asOf on clock regression without moving its page order", async () => {
    const later = NOW + 2 * HOUR
    const items: Item[] = [
      meeting("evt_a", iso(NOW + 1.5 * HOUR)),
      meeting("evt_a2", iso(later)),
      { id: "evt_z", status: "cancelled", updated: iso(NOW + 3 * HOUR) },
    ]
    const { runtime } = google(items)
    const first = await list(runtime, { since: later - HOUR, limit: 1 }, later)
    expect(ids(first.events)).toEqual(["evt_a"])
    expect(first.more).toBe(true)
    // The clock moves back two hours: opened is later than asOf, so the removal's `at` must not follow opened.
    const second = await list(runtime, { cursor: first.cursor, limit: 500 }, NOW)
    expect(ids(second.events)).toEqual(["evt_a2"])
    expect(second.removals).toEqual([{ external_id: "evt_z", at: iso(NOW), reason: "deleted" }])
    expect(resultProblems(second)).toEqual([])
  })

  it("uses the primary calendar's zone for a date-only value (Tokyo), not UTC midnight", async () => {
    const now = Date.parse("2026-10-31T23:00:00Z")
    const item: Item = { id: "evt_tokyo", status: "confirmed", start: { date: "2026-11-08" }, end: { date: "2026-11-09" } }
    const { runtime } = google([item], "Asia/Tokyo")
    const result = await list(runtime, { since: now - HOUR }, now)
    // Tokyo midnight on 8 November is 15:00Z on 7 November and is inside the window; UTC midnight would be outside.
    expect(ids(result.events)).toEqual(["evt_tokyo"])
    expect(result.events[0]?.occurred_at).toBe("2026-11-07T15:00:00.000Z")
  })
})

describe("persistent cursor progress", () => {
  it("fails a cross-response A -> B -> C -> A token cycle instead of resetting the per-call set", async () => {
    const pages: Record<string, { items: Item[]; next?: string }> = {
      "": { items: [meeting("evt_0", iso(NOW + 0.5 * HOUR))], next: "pageA" },
      pageA: { items: [meeting("evt_a", iso(NOW + 1 * HOUR))], next: "pageB" },
      pageB: { items: [meeting("evt_b", iso(NOW + 2 * HOUR))], next: "pageC" },
      pageC: { items: [meeting("evt_c", iso(NOW + 3 * HOUR))], next: "pageA" },
    }
    const read = async (request: { operation: string; params?: Record<string, unknown> }) => {
      if (request.operation === "calendar.calendarList.get") return { data: { id: CALENDAR, summary: "Sam Rivera", timeZone: "UTC" } }
      const token = typeof request.params?.["pageToken"] === "string" ? (request.params["pageToken"] as string) : ""
      const page = pages[token]
      if (!page) throw new Error(`no page ${token}`)
      return { data: { items: page.items, ...(page.next === undefined ? {} : { nextPageToken: page.next }) } }
    }
    const runtime = { read } as unknown as Pick<Runtime, "read">
    let cursor: string | undefined
    const seen: string[] = []
    for (let call = 0; call < 4; call++) {
      const page = await list(runtime, { ...(cursor === undefined ? { since: NOW - HOUR } : { cursor }), limit: 1 }, NOW)
      seen.push(...ids(page.events))
      cursor = page.cursor
      expect(page.more).toBe(true)
    }
    expect(seen).toEqual(["evt_0", "evt_a", "evt_b", "evt_c"])
    await expect(list(runtime, { cursor: cursor!, limit: 1 }, NOW)).rejects.toThrow(/^GWS_API_ERROR: The calendar repeated a page token/)
  })

  it("checkpoints one 350-character token plus the next digest, not two tokens", async () => {
    const tokenA = "a".repeat(350)
    const tokenB = "b".repeat(350)
    const pages: Record<string, { items: Item[]; next?: string }> = {
      "": { items: [meeting("evt_0", iso(NOW + 0.5 * HOUR))], next: tokenA },
      [tokenA]: { items: [meeting("evt_a", iso(NOW + 1 * HOUR))], next: tokenB },
      [tokenB]: { items: [meeting("evt_b", iso(NOW + 2 * HOUR))] },
    }
    const read = async (request: { operation: string; params?: Record<string, unknown> }) => {
      if (request.operation === "calendar.calendarList.get") return { data: { id: CALENDAR, summary: "Sam Rivera", timeZone: "UTC" } }
      const token = typeof request.params?.["pageToken"] === "string" ? (request.params["pageToken"] as string) : ""
      const page = pages[token]
      if (!page) throw new Error(`no page ${token}`)
      return { data: { items: page.items, ...(page.next === undefined ? {} : { nextPageToken: page.next }) } }
    }
    const runtime = { read } as unknown as Pick<Runtime, "read">
    const first = await list(runtime, { since: NOW - HOUR, limit: 1 }, NOW)
    const firstState = decodeBoundCursor(BINDING, first.cursor)
    expect(firstState.ok && firstState.state["p"]).toBeUndefined()
    expect(firstState.ok && firstState.state["q"]).toBeUndefined()
    expect(firstState.ok && firstState.state["h"]).toBe(createHash("sha256").update(tokenA).digest("hex").slice(0, 32))
    expect(first.cursor.length).toBeLessThanOrEqual(1024)
    const second = await list(runtime, { cursor: first.cursor, limit: 1 }, NOW)
    expect(ids(second.events)).toEqual(["evt_a"])
    const secondState = decodeBoundCursor(BINDING, second.cursor)
    expect(secondState.ok && secondState.state["p"]).toBeUndefined()
    expect(secondState.ok && secondState.state["q"]).toBe(tokenA)
    expect(secondState.ok && secondState.state["h"]).toBe(createHash("sha256").update(tokenB).digest("hex").slice(0, 32))
    // One 350-character previous token, not both tokens, keeps the checkpoint under the published cursor cap.
    expect(second.cursor.length).toBeLessThanOrEqual(1024)
    const third = await list(runtime, { cursor: second.cursor, limit: 1 }, NOW)
    expect(ids(third.events)).toEqual(["evt_b"])
    expect(third.more).toBe(false)
  })

  it("fails before fetching content page 501, but a partial page 500 still finishes", async () => {
    const digest = createHash("sha256").update(CALENDAR).digest("hex").slice(0, 16)
    const state = { a: ACCOUNT, o: digest, g: 1, w: NOW - HOUR, x: NOW + HORIZON + 1, i: NOW, n: 0, e: 500 }
    const capped = google([])
    const error = (await list(capped.runtime, { cursor: encodeBoundCursor(BINDING, state) }, NOW).catch((reason: unknown) => reason as Error)) as Error
    expect(error.message).toMatch(/^GWS_API_ERROR: The calendar window has more pages/)
    expect(error.message).not.toContain("fresh since")
    // Page 501 is never fetched.
    expect(capped.calls).toHaveLength(0)

    // A cursor inside content page 500 may finish that page's own outcomes without fetching page 501.
    const items = [meeting("evt_a", iso(NOW + HOUR)), meeting("evt_b", iso(NOW + 2 * HOUR))]
    const partial = google(items)
    const inside = { a: ACCOUNT, o: digest, g: 1, w: NOW - HOUR, x: NOW + HORIZON + 1, i: NOW, n: 0, e: 499 }
    const first = await list(partial.runtime, { cursor: encodeBoundCursor(BINDING, inside), limit: 1 }, NOW)
    expect(ids(first.events)).toEqual(["evt_a"])
    const second = await list(partial.runtime, { cursor: first.cursor, limit: 500 }, NOW)
    expect(ids(second.events)).toEqual(["evt_b"])
    expect(second.more).toBe(false)
    // One read for page 500's first event, one re-read to finish it; no page 501.
    expect(partial.calls).toHaveLength(2)
  })

  it("treats three sparse empty pages then a meeting as progress", async () => {
    const pages: Record<string, { items: Item[]; next?: string }> = {
      "": { items: [], next: "sparseA" },
      sparseA: { items: [], next: "sparseB" },
      sparseB: { items: [], next: "sparseC" },
      sparseC: { items: [meeting("evt_sparse", iso(NOW + HOUR))] },
    }
    const calls: string[] = []
    const read = async (request: { operation: string; params?: Record<string, unknown> }) => {
      if (request.operation === "calendar.calendarList.get") return { data: { id: CALENDAR, summary: "Sam Rivera", timeZone: "UTC" } }
      const token = typeof request.params?.["pageToken"] === "string" ? (request.params["pageToken"] as string) : ""
      calls.push(token)
      const page = pages[token]
      if (!page) throw new Error(`no page ${token}`)
      return { data: { items: page.items, ...(page.next === undefined ? {} : { nextPageToken: page.next }) } }
    }
    const runtime = { read } as unknown as Pick<Runtime, "read">
    const result = await list(runtime, { since: NOW - HOUR }, NOW)
    expect(ids(result.events)).toEqual(["evt_sparse"])
    expect(result.more).toBe(false)
    expect(calls).toEqual(["", "sparseA", "sparseB", "sparseC"])
  })
})

describe("checkpoint size with a supported long alias", () => {
  it("keeps paging beyond eight 350-character tokens with a 128-character alias, trimming only old history", async () => {
    const alias = "a".repeat(128)
    const token = (index: number) => `t${String(index).padStart(3, "0")}${"x".repeat(346)}`
    const pages: Record<string, { items: Item[]; next?: string }> = {
      "": { items: [meeting("evt_0", iso(NOW + 0.5 * HOUR))], next: token(1) },
    }
    for (let index = 1; index <= 9; index++) {
      pages[token(index)] = { items: [meeting(`evt_${index}`, iso(NOW + (index + 0.5) * HOUR))], next: token(index + 1) }
    }
    pages[token(10)] = { items: [meeting("evt_10", iso(NOW + 10.5 * HOUR))] }
    const read = async (request: { operation: string; params?: Record<string, unknown> }) => {
      if (request.operation === "calendar.calendarList.get") return { data: { id: CALENDAR, summary: "Sam Rivera", timeZone: "UTC" } }
      const tokenValue = typeof request.params?.["pageToken"] === "string" ? (request.params["pageToken"] as string) : ""
      const page = pages[tokenValue]
      if (!page) throw new Error(`no page ${tokenValue}`)
      return { data: { items: page.items, ...(page.next === undefined ? {} : { nextPageToken: page.next }) } }
    }
    const runtime = { read } as unknown as Pick<Runtime, "read">
    const binding = { plugin: "gws", source: "calendar", account: alias, scope: { calendars: ["primary"] } }
    const run = (cursor?: string) =>
      calendarEvents(runtime, alias, { source: "calendar", ...(cursor === undefined ? { since: NOW - HOUR } : { cursor }), limit: 1 }, ctx, NOW)
    let cursor: string | undefined
    for (let call = 0; call < 10; call++) {
      const page = await run(cursor)
      expect(page.events).toHaveLength(1)
      cursor = page.cursor
      expect(cursor.length).toBeLessThanOrEqual(1024)
      expect(decodeBoundCursor(binding, cursor).ok).toBe(true)
    }
    const decoded = decodeBoundCursor(binding, cursor!)
    expect(decoded.ok).toBe(true)
    const state = decoded.ok ? decoded.state : {}
    const actual = typeof state["j"] === "string" ? state["j"].split(".") : []
    expect(actual.length).toBeGreaterThan(0)
    expect(actual.length).toBeLessThanOrEqual(8)
    // The full eight-entry history would exceed 1,024 with this alias and token; the packed cursor drops only the oldest.
    const full = Array.from({ length: 8 }, (_, index) => createHash("sha256").update(token(index + 2)).digest("hex").slice(0, 16)).join(".")
    expect(() => encodeBoundCursor(binding, { ...state, j: full })).toThrow()
    expect(actual.length).toBeLessThan(8)
    const final = await run(cursor)
    expect(ids(final.events)).toEqual(["evt_10"])
    expect(final.more).toBe(false)
  })

  it("fails before emitting a checkpoint too large for the 1,024-character ceiling", async () => {
    const alias = "b".repeat(128)
    const long = "q".repeat(700)
    const pages: Record<string, { items: Item[]; next?: string }> = {
      "": { items: [meeting("evt_0", iso(NOW + 0.5 * HOUR))], next: long },
      [long]: { items: [meeting("evt_1", iso(NOW + 1 * HOUR))], next: "short" },
      short: { items: [meeting("evt_2", iso(NOW + 2 * HOUR))] },
    }
    const read = async (request: { operation: string; params?: Record<string, unknown> }) => {
      if (request.operation === "calendar.calendarList.get") return { data: { id: CALENDAR, summary: "Sam Rivera", timeZone: "UTC" } }
      const tokenValue = typeof request.params?.["pageToken"] === "string" ? (request.params["pageToken"] as string) : ""
      const page = pages[tokenValue]
      if (!page) throw new Error(`no page ${tokenValue}`)
      return { data: { items: page.items, ...(page.next === undefined ? {} : { nextPageToken: page.next }) } }
    }
    const runtime = { read } as unknown as Pick<Runtime, "read">
    const run = (cursor?: string) =>
      calendarEvents(runtime, alias, { source: "calendar", ...(cursor === undefined ? { since: NOW - HOUR } : { cursor }), limit: 1 }, ctx, NOW)
    const first = await run()
    expect(first.cursor.length).toBeLessThanOrEqual(1024)
    const error = (await run(first.cursor).catch((reason: unknown) => reason as Error)) as Error
    expect(error.message).toMatch(/^GWS_API_ERROR: The checkpoint is too large/)
    expect(error.message).not.toContain("fresh since")
  })
})
