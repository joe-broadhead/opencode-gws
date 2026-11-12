import { createHash } from "node:crypto"
import type { PluginConfig } from "./types.js"

/**
 * Today's calendar for Jelly's native calendar (`calendar.today`), as pure logic: which account answers, the bounds
 * of today in the calendar's own time zone, and Google's events turned into the shape Jelly reads
 * (hey-jelly `docs/architecture/plugin-native-data.md`). Nothing here reads Google or the clock: the host passes both.
 */

/** At most this many events in one answer (Jelly reads no more). */
export const CALENDAR_MAX_EVENTS = 50
const ID_MAX = 128
const TITLE_MAX = 200
const LOCATION_MAX = 200
const URL_MAX = 2048
/** What Google's own calendar shows for an event without a title. */
export const UNTITLED = "(No title)"

export interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  allDay?: true
  location?: string
  url?: string
  joinUrl?: string
}

export interface CalendarToday {
  account: string
  at: string
  state: "ready" | "stale"
  events: CalendarEvent[]
}

/**
 * The account that answers: the implicit `default` account when it enables Calendar, else the first configured
 * account that does, interactive accounts before headless ones. Undefined when none enables Calendar.
 */
export function calendarAccount(config: Pick<PluginConfig, "accounts">): string | undefined {
  const entries = Object.entries(config.accounts).filter(([, profile]) => profile.enabledServices.includes("calendar"))
  if (entries.some(([alias]) => alias === "default")) return "default"
  return (entries.find(([, profile]) => profile.mode === "interactive") ?? entries[0])?.[0]
}

/** Whether `zone` is a time zone this runtime knows. */
export function knownZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone === "") return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

type Day = { year: number; month: number; day: number }

function wallClock(instant: number, zone: string): Day & { hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant)
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value)
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute"), second: part("second") }
}

/** The zone's offset from UTC at `instant`, in milliseconds. */
function offset(instant: number, zone: string): number {
  const clock = wallClock(instant, zone)
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second) - Math.floor(instant / 1000) * 1000
}

const sameDay = (a: Day, b: Day) => a.year === b.year && a.month === b.month && a.day === b.day

/** The calendar day at `instant` in `zone`, as YYYY-MM-DD. */
export function dayKey(instant: number, zone: string): string {
  const { year, month, day } = wallClock(instant, zone)
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

/**
 * The first instant of a calendar day in `zone`. Where a clock change skips midnight, the day starts at the first
 * instant that reads as that day.
 */
function startOf(day: Day, zone: string): number {
  const midnight = Date.UTC(day.year, day.month - 1, day.day)
  const first = midnight - offset(midnight, zone)
  const second = midnight - offset(first, zone)
  const inDay = [first, second].filter((instant) => sameDay(wallClock(instant, zone), day))
  return inDay.length > 0 ? Math.min(...inDay) : Math.max(first, second)
}

const parseDate = (value: string): Day | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const day = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  const check = new Date(Date.UTC(day.year, day.month - 1, day.day))
  return check.getUTCFullYear() === day.year && check.getUTCMonth() === day.month - 1 && check.getUTCDate() === day.day ? day : undefined
}

const nextDay = (day: Day): Day => {
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day + 1))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

/** Today in `zone` at `now`: its first instant and the first instant of tomorrow. */
export function todayBounds(now: number, zone: string): { start: number; end: number } {
  const today = wallClock(now, zone)
  return { start: startOf(today, zone), end: startOf(nextDay(today), zone) }
}

/** An instant as Jelly reads it: ISO 8601 in UTC, to the second. */
export function iso(instant: number): string {
  return `${new Date(instant).toISOString().slice(0, 19)}Z`
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * A text field cut to `max` UTF-16 units (JavaScript's length, which Jelly checks) without splitting a character,
 * or undefined when it is not text or is blank.
 */
function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.replace(/\s+/gu, " ").trim()
  if (text === "") return undefined
  if (text.length <= max) return text
  let kept = ""
  for (const char of text) {
    if (kept.length + char.length > max - 1) break
    kept += char
  }
  return `${kept}…`
}

/** An https link without credentials, as Jelly accepts one; anything else is left out. */
export function httpsLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > URL_MAX) return undefined
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.href.length <= URL_MAX ? url.href : undefined
  } catch {
    return undefined
  }
}

/** Google's event id, or a stable digest of it when it is longer than Jelly reads. */
function eventId(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined
  return value.length <= ID_MAX ? value : `sha256:${createHash("sha256").update(value).digest("hex")}`
}

/** The video link Google gives the event: its Meet link, else a video entry point of its conference. */
function joinLink(event: Record<string, unknown>): string | undefined {
  const meet = httpsLink(event["hangoutLink"])
  if (meet) return meet
  const conference = event["conferenceData"]
  const points = isRecord(conference) && Array.isArray(conference["entryPoints"]) ? conference["entryPoints"] : []
  for (const point of points) {
    if (!isRecord(point) || point["entryPointType"] !== "video") continue
    const link = httpsLink(point["uri"])
    if (link) return link
  }
  return undefined
}

/** An event time: a timed instant, or an all-day date that starts at that day's first instant in `zone`. */
function timeOf(value: unknown, zone: string): { instant: number; allDay: boolean } | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value["dateTime"] === "string") {
    // RFC 3339 with an offset or Z, as Google sends it; a local time without one is not an instant.
    if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value["dateTime"])) return undefined
    const instant = Date.parse(value["dateTime"])
    return Number.isFinite(instant) ? { instant, allDay: false } : undefined
  }
  const day = typeof value["date"] === "string" ? parseDate(value["date"]) : undefined
  return day ? { instant: startOf(day, zone), allDay: true } : undefined
}

/** Whether the signed-in person declined the event. */
function declined(event: Record<string, unknown>): boolean {
  const attendees = Array.isArray(event["attendees"]) ? event["attendees"] : []
  return attendees.some((attendee) => isRecord(attendee) && attendee["self"] === true && attendee["responseStatus"] === "declined")
}

/** The fields `calendar.events.list` is asked for: only what the answer carries, and what filters it. */
export const EVENT_FIELDS =
  "items(id,status,eventType,summary,start,end,location,htmlLink,hangoutLink,conferenceData(entryPoints(entryPointType,uri)),attendees(self,responseStatus))"

/**
 * Google's `items` turned into today's events: inside [start, end) of today in `zone`, not cancelled, not declined,
 * not a working-location marker, and not yet ended at `now`. Earliest first, at most 50. An item missing an id or a
 * usable start and end is left out; a missing title reads as Google's own "(No title)".
 */
export function todayEvents(items: unknown, zone: string, now: number): CalendarEvent[] {
  const { start: dayStart, end: dayEnd } = todayBounds(now, zone)
  const events: (CalendarEvent & { order: number })[] = []
  for (const item of Array.isArray(items) ? items : []) {
    if (!isRecord(item) || item["status"] === "cancelled" || item["eventType"] === "workingLocation" || declined(item)) continue
    const id = eventId(item["id"])
    const start = timeOf(item["start"], zone)
    const end = timeOf(item["end"], zone)
    if (!id || !start || !end || start.allDay !== end.allDay || end.instant <= start.instant) continue
    if (start.instant >= dayEnd || end.instant <= dayStart || end.instant <= now) continue
    const location = clip(item["location"], LOCATION_MAX)
    const url = httpsLink(item["htmlLink"])
    const joinUrl = joinLink(item)
    events.push({
      order: start.instant,
      id,
      title: clip(item["summary"], TITLE_MAX) ?? UNTITLED,
      start: iso(start.instant),
      end: iso(end.instant),
      ...(start.allDay ? { allDay: true as const } : {}),
      ...(location ? { location } : {}),
      ...(url ? { url } : {}),
      ...(joinUrl ? { joinUrl } : {}),
    })
  }
  return events
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .slice(0, CALENDAR_MAX_EVENTS)
    .map(({ order: _order, ...event }) => event)
}
