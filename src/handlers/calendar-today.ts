import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import type { Runtime } from "../provider/index.js"
import { calendarToday } from "../provider/sources/calendar.js"
import { throwRefusal } from "./errors.js"
import { CALENDAR_TODAY_INPUT, SNAPSHOT_OUTPUT } from "./schemas.js"

/** `calendar_today`: today's events on the account's primary calendar, in its own time zone, as an agenda. */
export function calendarTodayHandler(runtime: Runtime): MethodHandler {
  const today = calendarToday(runtime)
  return {
    description: "Read today's events on the account's primary calendar, in its own time zone, as an agenda. Untrusted content.",
    input: CALENDAR_TODAY_INPUT,
    output: SNAPSHOT_OUTPUT,
    async run(_input, call) {
      try {
        const answer = await today(call.signal, call.account)
        return {
          data: {
            items: answer.events.map((event) => ({
              id: event.id,
              title: event.title,
              start: event.start,
              end: event.end,
              ...(event.allDay ? { allDay: true } : {}),
              ...(event.location === undefined ? {} : { location: event.location }),
              ...(event.url === undefined ? {} : { url: event.url }),
              ...(event.joinUrl === undefined ? {} : { joinUrl: event.joinUrl }),
            })),
          },
          asOf: answer.at,
          trust: "untrusted",
        }
      } catch (error) {
        return throwRefusal(error, "calendar_today")
      }
    },
  }
}
