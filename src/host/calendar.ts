import { Rpc } from "@opencode/plugin/rpc"
import { CALENDAR_MAX_EVENTS, type CalendarEvent, type CalendarToday, EVENT_FIELDS, calendarAccount, dayKey, iso, knownZone, todayBounds, todayEvents } from "../domain/calendar.js"
import { GwsError } from "../domain/errors.js"
import { PACKAGE_NAME } from "../domain/version.js"
import type { Runtime } from "../runtime/index.js"
import type { PluginContext } from "./context.js"

/**
 * `calendar.today`, the read Jelly's native calendar makes (hey-jelly `docs/architecture/plugin-native-data.md`).
 *
 * Jelly calls a view's method on the RPC registered under the package's own name, through its core plugin's relay,
 * with the input the method declares: `{}`. The host judges the declared permission, `gws.read`, against the agent's
 * rules before the call reaches the plugin; an RPC call carries no session, so the plugin cannot assert it itself.
 * The method reads only through the plugin's own read path (`runtime.read`: the account's own sign-in, the read
 * policy, the audit), never downloads gws, and never writes.
 *
 * One account answers (`calendarAccount`). Its primary calendar's own time zone sets today's bounds. A good answer
 * is kept in memory: a call within FRESH_MS of it is answered from it, and when a later read fails for any reason
 * but the sign-in, the kept events of the same day come back as `stale`, with the time they were read.
 */

/** A call this soon after a good read is answered from it, so a view that polls does not reach Google each time. */
export const FRESH_MS = 60_000
/** The read's own deadline, inside Jelly's ten seconds, so a slow Google still leaves time for the stale answer. */
export const READ_DEADLINE_MS = 8_000
/** How many events one `events.list` page asks for: today's ended events and declines can come first. */
const PAGE_SIZE = 250

const text = (min: number, max: number) => ({ type: "string", minLength: min, maxLength: max }) as const
const INSTANT = text(1, 80)

/** The method's declared schemas; `package.json` `jelly.rpc` carries the same two (test/calendar.test.ts). */
export const TODAY_INPUT = { type: "object", properties: {}, additionalProperties: false } as const
export const TODAY_OUTPUT = {
  type: "object",
  additionalProperties: false,
  required: ["account", "at", "state", "events"],
  properties: {
    account: text(1, 120),
    at: INSTANT,
    state: { type: "string", enum: ["ready", "stale"] },
    events: {
      type: "array",
      maxItems: CALENDAR_MAX_EVENTS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "start", "end"],
        properties: {
          id: text(1, 128),
          title: text(1, 200),
          start: INSTANT,
          end: INSTANT,
          allDay: { type: "boolean" },
          location: text(1, 200),
          url: text(1, 2048),
          joinUrl: text(1, 2048),
        },
      },
    },
  },
} as const
const FAILED = { type: "object", properties: { code: { type: "string" }, next: { type: "string" } }, required: ["code", "next"] } as const

export const CalendarRpc = Rpc.define({
  id: PACKAGE_NAME,
  methods: { "calendar.today": { input: TODAY_INPUT, output: TODAY_OUTPUT, errors: { failed: FAILED } } },
  events: {},
})

type Reader = Pick<Runtime, "config" | "read">
type Kept = { account: string; zone: string; day: string; at: number; events: CalendarEvent[] }

/** The sign-in codes: the kept events are dropped, so a signed-out calendar is never shown as stale. */
const SIGN_IN = new Set(["AUTH_REQUIRED", "AUTH_SCOPE_MISSING"])

/** Today's calendar, read through `runtime`, kept and answered stale as the module says. `now` is the clock. */
export function calendarToday(runtime: Reader, now: () => number = Date.now) {
  let kept: Kept | undefined
  let reading: Promise<Kept> | undefined

  const read = async (account: string, signal: AbortSignal): Promise<Kept> => {
    const ctx = { sessionId: "", agentId: "", caller: "rpc" as const, signal }
    const calendar = await runtime.read({ account, operation: "calendar.calendars.get", params: { calendarId: "primary", fields: "timeZone" } }, ctx)
    const zone = (calendar.data as { timeZone?: unknown } | undefined)?.timeZone
    if (!knownZone(zone)) throw new GwsError("CALENDAR_UNAVAILABLE", `Google's answer for the primary calendar of '${account}' names no time zone this runtime knows`)
    const at = now()
    const { start, end } = todayBounds(at, zone)
    const list = await runtime.read(
      {
        account,
        operation: "calendar.events.list",
        params: { calendarId: "primary", timeMin: iso(start), timeMax: iso(end), singleEvents: true, orderBy: "startTime", maxResults: PAGE_SIZE, fields: EVENT_FIELDS },
        response: { mode: "full" },
      },
      ctx,
    )
    if (list.truncated) throw new GwsError("OUTPUT_LIMIT", `today's events for '${account}' did not fit in one answer`)
    const items = (list.data as { items?: unknown } | undefined)?.items
    return { account, zone, day: dayKey(at, zone), at, events: todayEvents(items ?? [], zone, at) }
  }

  const answer = (entry: Kept, state: CalendarToday["state"]): CalendarToday => {
    const at = now()
    return { account: entry.account, at: iso(entry.at), state, events: entry.events.filter((event) => Date.parse(event.end) > at) }
  }

  return async (signal?: AbortSignal): Promise<CalendarToday> => {
    const account = calendarAccount(runtime.config)
    if (account === undefined)
      throw new GwsError("CALENDAR_UNAVAILABLE", "no configured account enables calendar", {
        next: "Add calendar to an account's enabledServices, or remove accounts so the default account enables it.",
      })
    if (kept && kept.account !== account) kept = undefined
    if (kept && now() - kept.at < FRESH_MS && dayKey(now(), kept.zone) === kept.day) return answer(kept, "ready")
    const deadline = AbortSignal.timeout(READ_DEADLINE_MS)
    reading ??= read(account, signal ? AbortSignal.any([signal, deadline]) : deadline).finally(() => {
      reading = undefined
    })
    try {
      kept = await reading
      return answer(kept, "ready")
    } catch (error) {
      if (signal?.aborted) throw error
      const code = GwsError.from(error)?.code
      if (code !== undefined && SIGN_IN.has(code)) kept = undefined
      else if (kept && dayKey(now(), kept.zone) === kept.day) return answer(kept, "stale")
      throw error
    }
  }
}

/** Register `calendar.today` on the RPC named after the package. A failure is `failed` with its code and next step. */
export async function registerCalendarRpc(ctx: Pick<PluginContext, "rpc">, runtime: Runtime): Promise<() => Promise<void>> {
  const today = calendarToday(runtime)
  const registration = await ctx.rpc.register(CalendarRpc, {
    "calendar.today": async (_input, context) => {
      try {
        return await runtime.wait((settled) => today(settled), context.signal)
      } catch (error) {
        const failure = GwsError.from(error)
        if (failure === undefined) throw error
        return context.error("failed", failure.message, { code: failure.code, next: failure.next })
      }
    },
  })
  return async () => {
    await registration.dispose().catch(() => undefined)
  }
}
