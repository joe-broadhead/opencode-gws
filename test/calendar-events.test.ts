import { createHash } from "node:crypto"
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EventsListInput, EventsListOutput } from "../src/domain/contract.js"
import {
  type EventsListInput as Input,
  type EventsListResult,
  assertEventsListConformance,
  encodeCursor,
  resultProblems,
} from "../src/host/events-list.js"
import { CALENDAR_READS, CALENDAR_SETUP, CALENDAR_SOURCE } from "../src/host/calendar-events.js"
import type { PermissionRequest } from "../src/host/permissions.js"
import { type Call, parse, toolSpecs } from "../src/host/tools.js"
import type { Runtime } from "../src/runtime/index.js"
import { account, testRuntime } from "./support/config.js"

/**
 * gws_events_list's calendar source, through its tool spec and the runtime,
 * against the fake gws answering from a synthetic calendar
 * (test/fixtures/calendar-mailbox.json): the shared contract's conformance
 * check, sync tokens and paging, a mid-page resume, an expired token's full
 * resync, a cancellation as a withdrawal, and the asserts that run before any
 * read.
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/calendar-mailbox.json", import.meta.url))
const SINCE = "2026-11-01T00:00:00Z"
const CALENDAR = "sam.rivera@example.com"
const OWNER = { id: CALENDAR, label: CALENDAR }

interface CalendarBox {
  id: string
  summary: string
  timeZone: string
  listings: Record<string, Array<{ items?: Array<Record<string, unknown>>; nextSyncToken?: string }> | 410>
}

let dir: string
let calendarPath: string
const runtimes: Runtime[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-gws-calendar-"))
  calendarPath = join(dir, "calendar.json")
  copyFileSync(FIXTURE, calendarPath)
  process.env["FAKE_GWS_CALENDAR"] = calendarPath
})

afterEach(async () => {
  delete process.env["FAKE_GWS_CALENDAR"]
  delete process.env["FAKE_GWS_LOG"]
  for (const runtime of runtimes.splice(0)) await runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

const calendarBox = (): CalendarBox => JSON.parse(readFileSync(calendarPath, "utf8")) as CalendarBox
const save = (box: CalendarBox) => writeFileSync(calendarPath, JSON.stringify(box))

/** The two services the source reads; the test account enables both. */
const TWO = { accounts: { personal: account({ services: ["gmail", "calendar"] }) } }

async function harness(assert: (request: PermissionRequest) => Promise<void> = async () => {}) {
  const runtime = await testRuntime(TWO)
  runtimes.push(runtime)
  const asserted: PermissionRequest[] = []
  const specs = toolSpecs(
    runtime,
    async (request) => {
      asserted.push(request)
      await assert(request)
    },
    async () => {
      throw new Error("events_list does not read the status")
    },
  )
  const spec = specs.find((candidate) => candidate.name === "events_list")!
  const call: Call = {
    host: { sessionID: "ses_collect", agent: "build", messageID: "msg_1", id: "call_1" },
    runtime: { sessionId: "ses_collect", agentId: "build", signal: new AbortController().signal },
  }
  /** events_list as the tool and the RPC method run it: the input schema, then the spec. This plugin has two sources, so the test names calendar as a collector must. */
  const list = async (input: Input): Promise<EventsListResult> => (await spec.run(parse(spec.input, { source: "calendar", ...input }), call)).output as EventsListResult
  return { runtime, asserted, spec, list }
}

const ids = (result: EventsListResult) => result.events.map((event) => event.external_id)

/** Every calendar.events.list argv the fake logged, its --params parsed. */
function calls(): Array<Record<string, unknown>> {
  const log = process.env["FAKE_GWS_LOG"]
  if (!log) return []
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[])
    .filter((argv) => argv.join(" ").includes("calendar events list"))
    .map((argv) => JSON.parse(argv[argv.indexOf("--params") + 1]!) as Record<string, unknown>)
}

const digest = (calendar: string) => createHash("sha256").update(calendar).digest("hex").slice(0, 16)

/**
 * Memory's recording session: the rules are exactly `grants`, so an assert outside them fails as the real session would.
 * A grant on `*` matches any resource; an `{account}:<operation>` grant is exact, with the account alias bound.
 */
function recording(grants: ReadonlyArray<{ action: string; resource: string }>) {
  const requests: PermissionRequest[] = []
  const assert = async (request: PermissionRequest) => {
    requests.push(request)
    const declared = grants.some((grant) => grant.action === request.action && (grant.resource === "*" || grant.resource === request.resources[0]))
    if (!declared) throw new Error(`undeclared action: ${request.action} on ${request.resources.join(" ")}`)
  }
  return { requests, assert }
}

describe("the calendar source keeps the shared contract", () => {
  it("passes the conformance check over the synthetic calendar, page by page", async () => {
    const { list } = await harness()
    await assertEventsListConformance(list, { source: CALENDAR_SOURCE, account: "personal", owner: OWNER, since: SINCE, scope: { calendars: ["primary"] }, expected: ["evt-b", "evt-a", "evt-c"] })
    await assertEventsListConformance(list, { source: CALENDAR_SOURCE, account: "personal", owner: OWNER, since: SINCE, scope: { calendars: ["primary"] }, expected: ["evt-b", "evt-a", "evt-c"], pageSize: 1 })
  })

  it("names the primary calendar on the owner-only call, and lists nothing", async () => {
    const { asserted, list } = await harness()
    const log = join(dir, "argv.log")
    process.env["FAKE_GWS_LOG"] = log
    writeFileSync(log, "")
    const ownerOnly = await list({ limit: 0, source: "calendar" })
    expect(ownerOnly).toMatchObject({ source: "calendar", account: "personal", owner: OWNER, scope: { calendars: ["primary"] }, setup: CALENDAR_SETUP, events: [], more: false, trust: "untrusted" })
    expect(resultProblems(ownerOnly, 0)).toEqual([])
    // The identity read ran and was the only read asserted; the events read was neither asserted nor run.
    expect(calls()).toEqual([])
    expect(asserted.map((request) => [request.action, request.resources])).toEqual([
      ["gws.events_list", ["personal:calendar.events.list"]],
      ["gws.read", ["personal:calendar.calendarList.get"]],
    ])
    expect(readFileSync(log, "utf8")).toContain('"calendar","calendarList","get"')
  })

  it("asserts exactly the identity grants on the owner-only call, and no other read", async () => {
    const identity = recording([
      { action: "gws.events_list", resource: "*" },
      { action: "gws.read", resource: `personal:${CALENDAR_READS[0]}` },
    ])
    const { list } = await harness(identity.assert)
    await list({ limit: 0, source: "calendar" })
    expect(identity.requests.map((request) => [request.action, request.resources])).toEqual([
      ["gws.events_list", ["personal:calendar.events.list"]],
      ["gws.read", [`personal:${CALENDAR_READS[0]}`]],
    ])
    // A listing needs the events read, so under the identity grants alone it is refused before any read runs.
    const listed = await harness(identity.assert)
    await expect(listed.list({ since: SINCE, limit: 1 })).rejects.toThrow(/undeclared action/)
  })

  it("asserts exactly the source grants on a listing", async () => {
    const source = recording([
      { action: "gws.events_list", resource: "*" },
      ...CALENDAR_READS.map((operation) => ({ action: "gws.read", resource: `personal:${operation}` })),
    ])
    const { list } = await harness(source.assert)
    expect(ids(await list({ since: SINCE, limit: 1 }))).toEqual(["evt-b"])
  })

  it("echoes the scope it read, and refuses a calendar that is not this account's primary", async () => {
    const { list } = await harness()
    expect((await list({ since: SINCE, scope: { calendars: [CALENDAR] } })).scope).toEqual({ calendars: [CALENDAR] })
    await expect(list({ since: SINCE, scope: { calendars: ["someone.else@example.com"] } })).rejects.toThrow(/^GWS_VALIDATION_ERROR: The calendar 'someone.else@example.com' is not this account's primary calendar/)
    await expect(list({ since: SINCE, scope: { calendars: ["primary", CALENDAR] } })).rejects.toThrow(/^GWS_VALIDATION_ERROR: Events_list reads one calendar at a time/)
    await expect(list({ since: SINCE, scope: { channels: ["C1234567890"] } })).rejects.toThrow(/^GWS_VALIDATION_ERROR: Calendar has no scope key 'channels'/)
  })
})

describe("the events", () => {
  it("makes a meeting with its organizer and attendees, and an all-day event at UTC midnight", async () => {
    const { list } = await harness()
    const result = await list({ since: SINCE, scope: { calendars: ["primary"] } })
    expect(resultProblems(result)).toEqual([])
    const [cancelled, meeting, review] = result.events
    expect(meeting).toMatchObject({
      source: "calendar",
      account: "personal",
      external_id: "evt-a",
      kind: "meeting",
      occurred_at: "2026-11-01T10:00:00.000Z",
      thread: null,
      title: "Quarterly plan",
      text: "Agenda: Q4 numbers, hiring, the board pack.\n\nRoom 3",
      url: "https://calendar.google.com/calendar/event?eid=evt-a",
      labels: ["calendar", "confirmed"],
      actors: [
        { role: "organizer", id: "mailto:ama.mensah@example.com", name: "Ama Mensah" },
        { role: "attendee", id: "mailto:ama.mensah@example.com", name: "Ama Mensah" },
        { role: "self", id: "mailto:sam.rivera@example.com", name: "Sam Rivera" },
      ],
    })
    expect(review).toMatchObject({ external_id: "evt-c", kind: "meeting", actors: [{ role: "organizer", id: "mailto:sam.rivera@example.com" }, { role: "attendee", id: "mailto:jordan.lee@example.org", name: "Jordan Lee" }] })
    // A cancellation is a withdrawal: the same event id, no title, text or actors from the meeting it retires.
    expect(cancelled).toMatchObject({
      external_id: "evt-b",
      kind: "event",
      occurred_at: "2026-11-01T09:00:00.000Z",
      title: "Lunch with Jordan",
      text: "",
      actors: [],
      labels: ["calendar", "cancelled"],
    })
  })

  it("all-day events are dated at UTC midnight", async () => {
    const box = calendarBox()
    box.listings["full"] = [{ items: [{ id: "evt-allday", status: "confirmed", summary: "Company day", start: { date: "2026-11-05" }, end: { date: "2026-11-06" }, updated: "2026-11-01T00:00:00Z" }], nextSyncToken: "sync-1" }]
    save(box)
    const { list } = await harness()
    expect((await list({ since: SINCE })).events[0]).toMatchObject({ external_id: "evt-allday", kind: "meeting", occurred_at: "2026-11-05T00:00:00.000Z", text: "" })
  })
})

describe("sync tokens and paging", () => {
  it("follows a sync token after the full sync, and a cancellation replaces the meeting with the same id", async () => {
    const { list } = await harness()
    const first = await list({ since: SINCE, limit: 500 })
    expect(ids(first)).toEqual(["evt-b", "evt-a", "evt-c"])
    expect(first.more).toBe(false)

    // Between calls: the design review is cancelled, and a new meeting is added. Google reports both from sync-1.
    const box = calendarBox()
    box.listings["sync-1"] = [
      {
        items: [
          { id: "evt-c", status: "cancelled", summary: "Design review", start: { dateTime: "2026-11-03T09:00:00Z" }, end: { dateTime: "2026-11-03T10:00:00Z" }, updated: "2026-11-03T14:00:00Z", htmlLink: "https://calendar.google.com/calendar/event?eid=evt-c" },
          {
            id: "evt-d",
            status: "confirmed",
            summary: "Board pack handover",
            description: "Send Ama the numbers before the pack goes out.",
            start: { dateTime: "2026-11-04T09:00:00Z" },
            end: { dateTime: "2026-11-04T09:30:00Z" },
            updated: "2026-11-03T12:00:00Z",
            htmlLink: "https://calendar.google.com/calendar/event?eid=evt-d",
            organizer: { email: "ama.mensah@example.com" },
            attendees: [{ email: "sam.rivera@example.com", self: true, responseStatus: "accepted" }],
          },
        ],
        nextSyncToken: "sync-2",
      },
    ]
    save(box)

    const second = await list({ cursor: first.cursor })
    expect(ids(second)).toEqual(["evt-c", "evt-d"])
    expect(second.events[0]).toMatchObject({ external_id: "evt-c", kind: "event", labels: ["calendar", "cancelled"], text: "" })
    expect(second.more).toBe(false)

    const third = await list({ cursor: second.cursor })
    expect(third).toMatchObject({ events: [], more: false })
    expect(resultProblems(third)).toEqual([])
  })

  it("saves the page token mid-sync: the sync token comes only on the last page", async () => {
    const { list } = await harness()
    const log = join(dir, "argv.log")
    process.env["FAKE_GWS_LOG"] = log
    writeFileSync(log, "")

    const first = await list({ since: SINCE, limit: 1 })
    expect(ids(first)).toEqual(["evt-b"])
    expect(first.more).toBe(true)
    // The first page is read without a page token, and it carried one: the cursor holds the window, not a token.
    const [one] = calls()
    expect(one).toMatchObject({ timeMin: "2026-11-01T00:00:00.000Z", showDeleted: true, singleEvents: true })
    expect(one?.["syncToken"]).toBeUndefined()

    const second = await list({ cursor: first.cursor, limit: 1 })
    expect(ids(second)).toEqual(["evt-a"])
    // Mid-page: no page token was used, so the same first page is read again and its second entry taken.
    expect(calls().at(-1)).toMatchObject({ timeMin: "2026-11-01T00:00:00.000Z" })
    expect(calls().at(-1)?.["pageToken"]).toBeUndefined()

    const third = await list({ cursor: second.cursor, limit: 1 })
    expect(ids(third)).toEqual(["evt-c"])
    // The second page is read with the first page's token, and still no window.
    expect(calls().at(-1)).toMatchObject({ pageToken: "1", showDeleted: true })
    expect(calls().at(-1)?.["syncToken"]).toBeUndefined()
    // The last page carried the sync token, so it is adopted only now.
    expect(JSON.parse(Buffer.from(third.cursor, "base64url").toString("utf8"))).toMatchObject({ s: "calendar", y: "sync-1" })

    const fourth = await list({ cursor: third.cursor })
    expect(fourth).toMatchObject({ events: [], more: false })
  })

  it("starts a full resync when Google expires the sync token with a 410", async () => {
    const { list } = await harness()
    const log = join(dir, "argv.log")
    process.env["FAKE_GWS_LOG"] = log
    writeFileSync(log, "")
    const expired = encodeCursor(CALENDAR_SOURCE, { a: "personal", o: digest(CALENDAR), y: "sync-expired", w: 0, t: Date.parse(SINCE), n: 0 })

    const result = await list({ cursor: expired })
    expect(ids(result)).toEqual(["evt-b", "evt-a", "evt-c"])
    expect(result.more).toBe(false)
    // The expired token was tried once, then the full sync ran from the last event's time.
    const [first, second] = calls()
    expect(first).toMatchObject({ syncToken: "sync-expired" })
    expect(second).toMatchObject({ timeMin: "2026-11-01T00:00:00.000Z" })
    expect(second?.["syncToken"]).toBeUndefined()
    // The new cursor carries the sync token from the full sync's last page, and the answer says it restarted.
    expect(JSON.parse(Buffer.from(result.cursor, "base64url").toString("utf8"))).toMatchObject({ s: "calendar", y: "sync-1" })
    expect(result.gap).toMatchObject({ reason: "sync-token-expired", since: expect.stringMatching(/Z$/) })
    expect(resultProblems(result)).toEqual([])
  })

  it("truncates a full sync's window to 31 days and reports window-truncated, never a resync", async () => {
    const { list } = await harness()
    const log = join(dir, "argv.log")
    process.env["FAKE_GWS_LOG"] = log
    writeFileSync(log, "")
    const result = await list({ since: "2020-01-01T00:00:00Z", limit: 500 })
    expect(result.gap).toMatchObject({ reason: "window-truncated", since: expect.stringMatching(/Z$/) })
    expect(resultProblems(result)).toEqual([])
    // The read asked from at most 31 days back, not from 2020.
    const [first] = calls()
    expect(first).toMatchObject({ showDeleted: true })
    const since = Date.parse(String(first?.["timeMin"]))
    expect(since).toBeGreaterThan(Date.now() - 31 * 86_400_000)
    expect(result.events.every((event) => Date.parse(event.occurred_at) >= since)).toBe(true)
  })

  it("refuses another account's cursor, another calendar's, and another source's", async () => {
    const { list } = await harness()
    const first = await list({ since: SINCE })
    await expect(list({ cursor: first.cursor, account: "work" })).rejects.toThrow(/^ACCOUNT_UNKNOWN:/)
    save({ ...calendarBox(), id: "someone.else@example.com" })
    await expect(list({ cursor: first.cursor })).rejects.toThrow(/^CURSOR_INVALID:/)
    await expect(list({ cursor: encodeCursor("gmail", { a: "personal" }) })).rejects.toThrow(/^CURSOR_INVALID:/)
  })
})

describe("permissions", () => {
  it("asserts gws.events_list on calendar.events.list, then gws.read on exactly the declared reads", async () => {
    const { asserted, list } = await harness()
    await list({ since: SINCE, limit: 1 })
    expect(asserted.map((request) => [request.action, request.resources])).toEqual([
      ["gws.events_list", ["personal:calendar.events.list"]],
      ...CALENDAR_READS.map((operation) => ["gws.read", [`personal:${operation}`]]),
    ])
    expect(asserted.every((request) => request.source?.type === "tool")).toBe(true)
  })

  it("refuses the call before any read when a declared read is denied", async () => {
    const log = join(dir, "argv.log")
    process.env["FAKE_GWS_LOG"] = log
    writeFileSync(log, "")
    const { list } = await harness(async (request) => {
      if (request.action === "gws.read" && request.resources[0] === "personal:calendar.events.list") throw new Error("denied by rule")
    })
    await expect(list({ since: SINCE })).rejects.toThrow("denied by rule")
    expect(readFileSync(log, "utf8")).not.toContain('"calendar"')
  })
})

describe("the host's output schema", () => {
  it("accepts a calendar result", async () => {
    const { spec, list } = await harness()
    expect(spec.input.safeParse({ source: "calendar", scope: { calendars: ["primary"] } }).success).toBe(true)
    expect(spec.output.safeParse(await list({ since: SINCE })).success).toBe(true)
    expect(EventsListInput.safeParse({ limit: 0 }).success).toBe(true)
    expect(EventsListOutput.safeParse({}).success).toBe(false)
  })
})
