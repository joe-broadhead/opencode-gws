import { GwsError } from "../domain/errors.js"
import type { CallContext } from "../runtime/accounts.js"
import type { Runtime } from "../runtime/index.js"
import { CALENDAR_FOLLOW, CALENDAR_READS, CALENDAR_SOURCE, calendarEvents } from "./calendar-events.js"
import { type EventsListRequest, type EventsListResult, parseEventsListInput } from "./events-page.js"
import { GMAIL_FOLLOW, GMAIL_READS, GMAIL_SOURCE, gmailEvents } from "./gmail-events.js"

/**
 * The sources `events_list` serves, one module each: Gmail's messages and
 * Calendar's events. A source names the reads it makes, the operation
 * `gws.events_list` is asserted on, and the function that lists it, so the
 * tool asserts exactly a source's reads and nothing wider.
 */

/** One source of `events_list`. */
export interface EventSource {
  /** The `source` value that names it. */
  readonly id: string
  /** Every read it makes, the identity read first. */
  readonly reads: readonly string[]
  /** The operation `gws.events_list` is asserted on: the one the listing follows. */
  readonly follow: string
  /** Lists the source for `account`, as the shared contract describes. */
  readonly run: (runtime: Pick<Runtime, "read">, account: string, request: EventsListRequest, ctx: CallContext, now?: number) => Promise<EventsListResult>
}

const SOURCES: readonly EventSource[] = [
  { id: GMAIL_SOURCE, reads: GMAIL_READS, follow: GMAIL_FOLLOW, run: gmailEvents },
  { id: CALENDAR_SOURCE, reads: CALENDAR_READS, follow: CALENDAR_FOLLOW, run: calendarEvents },
]

/** The sources events_list serves, in the order a call without `source` considers them. */
export const EVENT_SOURCES: readonly string[] = SOURCES.map((source) => source.id)

/** A source by its name. */
export function eventSource(id: string): EventSource | undefined {
  return SOURCES.find((source) => source.id === id)
}

/** A request's problems as GWS_VALIDATION_ERROR, or the parsed request; a source the plugin does not have is refused. */
export function eventsRequest(input: unknown): EventsListRequest {
  const parsed = parseEventsListInput(input)
  if (!parsed.ok) throw new GwsError("GWS_VALIDATION_ERROR", parsed.problems.join("; "))
  const { source } = parsed.value
  if (source !== undefined && !EVENT_SOURCES.includes(source)) {
    throw new GwsError("GWS_VALIDATION_ERROR", `the source '${source}' is not available: events_list lists ${EVENT_SOURCES.join(" and ")}`, {
      next: `Call events_list without source, or with source ${EVENT_SOURCES.map((id) => `"${id}"`).join(" or ")}.`,
    })
  }
  return parsed.value
}

/** The source a parsed request lists: the one it names, or the plugin's first. */
export function sourceFor(request: EventsListRequest): EventSource {
  const source = eventSource(request.source ?? GMAIL_SOURCE)
  // `eventsRequest` refused anything else, so this is the plugin's own bug, not a caller's.
  if (!source) throw new GwsError("GWS_VALIDATION_ERROR", `events_list has no source '${request.source}'`)
  return source
}
