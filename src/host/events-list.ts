/**
 * The events_list source contract: how Memory's collector reads what happened in a source since it last looked
 * (opencode-mem `docs/design/memory-v1-contracts.md` §2.3 and §4.5, `memory-funnel-v1.md` §4 and §5).
 *
 *   events_list({ since?, cursor?, limit?, account?, source? })
 *     → { source, account, owner, events, cursor, more, trust: "untrusted" }
 *
 * A source plugin adds one read-only tool and tools-RPC method named `events_list`. It never writes, never asks and
 * never calls a model, so a scheduled check can run it with no one there. The rules, which `eventsListConformance`
 * tests against any source:
 *
 * - **Input.** `since` is an ISO date (a UTC day) or an ISO date-time with `Z` or an offset. `cursor` is a string a
 *   previous result of the same source and account returned. `limit` is an integer from 0 to 500, 100 by default;
 *   `limit: 0` is contract 2's owner-only call, which lists nothing and answers the owner and the scope options.
 *   `account` names one of the source's accounts; without it the source uses its default. `source` names one of the
 *   plugin's sources (gws: `gmail` and `calendar`); without it the plugin uses its first, and it refuses a
 *   source it does not have. `scope` (contract 2) names the ids under the source's declared scope keys, such as
 *   `{ calendars: ["primary"] }`, and every result echoes it. A cursor wins over `since`.
 *   With neither, the source starts `FIRST_RUN_HOURS` before now. Anything else is refused, and a cursor the source
 *   did not issue (another source, another account, a malformed one) is refused rather than restarted.
 * - **Events.** Each is a `SourceEvent`: the source's own record of one thing, normalised. `text` is at most 4096
 *   characters, `title` at most 300, `actors` at most 20, and `hash` is `eventHash` of the rest. Memory sets the
 *   event's `id` from `source:account:external_id`, so a repeat is harmless. Events are oldest first within a result.
 * - **Cursor.** Opaque: only the source reads it, through `encodeCursor` and `decodeCursor`. Every result carries one,
 *   empty pages included, at most 1024 characters. Calling again with it lists what follows the result's last event
 *   and never skips anything; calling again with an older cursor lists the same events again, so a collector that
 *   failed to store its batch retries safely. `more` is true when another call now would list more.
 * - **Size.** A result's JSON is at most `MAX_PAGE_BYTES`; a source that would pass it stops early (`fitPage`).
 * - **Source, account, owner and trust.** Every result names its `source` and `account`, empty pages included, so a
 *   first call that finds nothing can still be bound; every event names the same two. `owner` is the signed-in source
 *   account (`{ id, label }`), which Memory checks against the person's binding before it stores anything. `trust` is
 *   always "untrusted": events are data, never instructions.
 *
 * Shared module. Each source plugin keeps an identical copy at `src/host/events-list.ts`, because each bundle stands
 * alone; the plugin's `scripts/check-copies.mjs` fails its check when the copy differs from the one every source
 * plugin carries. Change it in every plugin at once, then update the hash there. It imports only `node:crypto`.
 */
import { createHash } from "node:crypto"

/** The tool's and the tools-RPC method's name. */
export const EVENTS_LIST = "events_list"

export const EVENT_KINDS = ["message", "meeting", "session", "bookmark", "issue", "pr", "commit", "doc", "event"] as const
export type EventKind = (typeof EVENT_KINDS)[number]

/** The most characters each field takes, and the most items each list takes. */
export const EVENT_LIMITS = {
  source: 64,
  account: 128,
  externalId: 512,
  thread: 512,
  title: 300,
  text: 4096,
  url: 2048,
  actors: 20,
  actorRole: 32,
  actorId: 320,
  actorName: 200,
  labels: 20,
  label: 64,
  ownerId: 320,
  ownerLabel: 200,
  cursor: 1024,
} as const

/**
 * `limit`'s default and inclusive range. `limit: 0` is contract 2's owner-only call: it reads the owner and the
 * scope options, and lists nothing.
 */
export const PAGE = { default: 100, min: 0, max: 500 } as const

/** The most bytes of JSON one result holds. A source stops early, and says `more`, rather than pass it. */
export const MAX_PAGE_BYTES = 900_000

/** Contract 2: the most scope keys one call carries, the most ids under one key, and an id's longest form. */
export const SCOPE = { keys: 8, ids: 64, id: 128 } as const

/** A scope key: a lowercase word such as `calendars` or `channels`. */
export const SCOPE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/

/**
 * Contract 2: what a call reads, as ids under the source's declared scope keys, such as `{ calendars: ["primary"] }`.
 * A result echoes it, so Memory can pin it to the person's confirmed scope. An empty object is the whole source.
 */
export type EventsScope = Readonly<Record<string, readonly string[]>>

/** Where a listing starts when the call has neither cursor nor since: this many hours before now. */
export const FIRST_RUN_HOURS = 24

/** Contract 2's `gap`: the reasons a source restarted its window, and the furthest back `since` may name. */
export const GAP_REASONS = ["expired", "window-truncated"] as const
export type GapReason = (typeof GAP_REASONS)[number]
export const GAP_MAX_DAYS = 31

export const TRUST = "untrusted" as const

/** Someone or something an event involves. `id` is a stable, scheme-qualified id: `mailto:…`, `slack:U…`, `github:…`. */
export interface EventActor {
  readonly role: string
  readonly id: string
  readonly name?: string
}

/** One normalised event, as a source lists it. Memory adds `id`. */
export interface SourceEvent {
  readonly source: string
  readonly account: string
  readonly external_id: string
  readonly kind: EventKind
  /** UTC, as `Date.prototype.toISOString` writes it. */
  readonly occurred_at: string
  readonly thread: string | null
  readonly actors: EventActor[]
  readonly title: string
  readonly text: string
  /** An https link to the thing in the source, or null when it has none. */
  readonly url: string | null
  readonly labels: string[]
  /** `sha256:<hex>` of every other field, from `eventHash`. */
  readonly hash: string
}

/** The signed-in source account. */
export interface EventsOwner {
  readonly id: string
  readonly label: string
}

/**
 * Contract 2's `gap`: the source restarted its window, so Memory may have missed events. `window-truncated` marks the
 * run possibly incomplete and never forces a resync; `sync-token-expired` and `cursor-invalid` do trigger Memory's one
 * resync a day. `since` is the start of the window the source read instead, no more than `GAP_MAX_DAYS` before now.
 */
export interface EventsGap {
  readonly reason: GapReason
  readonly since: string
  readonly until?: string
}

export interface EventsListInput {
  readonly since?: string
  readonly cursor?: string
  readonly limit?: number
  readonly account?: string
  readonly source?: string
  readonly scope?: EventsScope
}

/** A final drop, with the contract's reason. */
export interface RefusedDrop {
  readonly external_id: string
  readonly reason: "instruction" | "secret" | "owner"
  readonly detail?: string
}

/** A retryable drop, with the contract's error code. */
export interface FailedDrop {
  readonly external_id: string
  readonly code: string
  readonly retryAfterSec?: number
}

export interface EventsListResult {
  /** The contract source id every page names (`gws.gmail`), also on an empty page. */
  readonly source: string
  /** The account every event names, also on an empty page. */
  readonly account: string
  readonly owner: EventsOwner
  /** The scope this call read, echoed; `{}` is the whole source. */
  readonly scope: EventsScope
  /** The package every page names. */
  readonly plugin: string
  /** When the page was read, ISO UTC. */
  readonly asOf: string
  readonly events: SourceEvent[]
  readonly cursor: string
  readonly more: boolean
  readonly trust: typeof TRUST
  /** Final drops: the consumer may advance past them. */
  readonly refused: RefusedDrop[]
  /** Retryable drops: any entry holds the cursor back. */
  readonly failed: FailedDrop[]
  /** Present only when the source restarted its window; absent on an ordinary page. */
  readonly gap?: EventsGap
  /** What the provider reported; free sources omit it. */
  readonly cost?: Readonly<Record<string, unknown>>
}

/** An input after `parseEventsListInput`: `since` in epoch milliseconds, `limit` with its default. */
export interface EventsListRequest {
  readonly since?: number
  readonly cursor?: string
  readonly limit: number
  readonly account?: string
  readonly source?: string
  readonly scope?: EventsScope
}

// ── Input ───────────────────────────────────────────────────────────────

/** An ISO date (a UTC day), or an ISO date-time with seconds optional and `Z` or an offset. */
export const SINCE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/

/** A source's name: a lowercase word such as gmail or history. */
export const SOURCE_PATTERN = /^[a-z][a-z0-9-]*$/

/** The contract source id: a plugin prefix and a source name, such as gws.gmail. */
export const SOURCE_ID_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/

const INPUT_KEYS: readonly string[] = ["since", "cursor", "limit", "account", "source", "scope"]
/** True when the text has a control character (U+0000 to U+001F, or U+007F). */
const hasControl = (text: string) => [...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)

const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * A scope's problems, one sentence each, naming keys and never ids. `where` names the scope in the sentence, such as
 * `"scope"` or `the result's scope`. A scope is at most `SCOPE.keys` keys, each a lowercase word, and under each
 * `SCOPE.ids` distinct ids of at most `SCOPE.id` characters.
 */
export function scopeProblems(scope: unknown, where: string): string[] {
  if (!plainObject(scope)) return [`${where} must be an object of ids under the source's scope keys`]
  const problems: string[] = []
  const keys = Object.keys(scope)
  if (keys.length > SCOPE.keys) problems.push(`${where} has ${keys.length} keys, over ${SCOPE.keys}`)
  for (const key of keys) {
    if (!SCOPE_KEY_PATTERN.test(key)) problems.push(`${where} has the key "${cut(key, 32)}", which is not a lowercase word`)
    const ids = scope[key]
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > SCOPE.ids) {
      problems.push(`${where}.${cut(key, 32)} must be a list of 1 to ${SCOPE.ids} ids`)
      continue
    }
    if (ids.some((id) => typeof id !== "string" || id.length === 0 || id.length > SCOPE.id || hasControl(id))) {
      problems.push(`${where}.${cut(key, 32)} has an id that is not a non-empty line of at most ${SCOPE.id} characters`)
      continue
    }
    if (new Set(ids).size !== ids.length) problems.push(`${where}.${cut(key, 32)} repeats an id`)
  }
  return problems
}

/** A validated scope, as it is echoed: its keys in the order given, each with its ids. */
export function copyScope(scope: EventsScope): Record<string, string[]> {
  return Object.fromEntries(Object.entries(scope).map(([key, ids]) => [key, [...ids]]))
}

/**
 * A `gap`'s problems, one sentence each; none when it keeps contract 2. `now` is the clock its `since` is measured
 * against: `since` and `until` are ISO 8601 UTC, `since ≤ until`, and `since` no more than `GAP_MAX_DAYS` before now.
 */
export function gapProblems(gap: unknown, now = Date.now()): string[] {
  if (!plainObject(gap)) return ["the gap must be { reason, since, until? }"]
  const problems: string[] = []
  for (const key of Object.keys(gap)) if (!["reason", "since", "until"].includes(key)) problems.push(`the gap has the field "${key}", which the contract does not define`)
  if (!(GAP_REASONS as readonly unknown[]).includes(gap["reason"])) problems.push(`the gap's reason must be one of ${GAP_REASONS.join(", ")}`)
  const time = (value: unknown) => (typeof value === "string" && ISO_UTC.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined)
  const since = time(gap["since"])
  if (since === undefined) problems.push("the gap's since must be an ISO 8601 UTC date-time ending in Z")
  if (gap["until"] !== undefined && time(gap["until"]) === undefined) problems.push("the gap's until must be an ISO 8601 UTC date-time ending in Z")
  const until = gap["until"] === undefined ? undefined : time(gap["until"])
  if (since !== undefined && until !== undefined && since > until) problems.push("the gap's since is after its until")
  if (since !== undefined && since < now - GAP_MAX_DAYS * 86_400_000) problems.push(`the gap's since is more than ${GAP_MAX_DAYS} days before now`)
  return problems
}

/** `since` in epoch milliseconds; undefined when it is not one of the accepted forms or not a real time. */
export function sinceTime(since: string): number | undefined {
  if (!SINCE_PATTERN.test(since)) return undefined
  const time = Date.parse(since.length === 10 ? `${since}T00:00:00Z` : since)
  return Number.isFinite(time) ? time : undefined
}

/** The input checked and normalised, or the problems with it, one sentence each, naming fields and never values. */
export function parseEventsListInput(input: unknown): { ok: true; value: EventsListRequest } | { ok: false; problems: string[] } {
  const value = input === undefined || input === null ? {} : input
  if (!plainObject(value)) return { ok: false, problems: ["the input must be an object"] }
  const problems = Object.keys(value).filter((key) => !INPUT_KEYS.includes(key)).map((key) => `"${key}" is not an input of events_list`)
  const { since, cursor, limit, account, source, scope } = value
  let time: number | undefined
  if (since !== undefined) {
    time = typeof since === "string" ? sinceTime(since) : undefined
    if (time === undefined) problems.push(`"since" must be an ISO date, or an ISO date-time with Z or an offset`)
  }
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0 || cursor.length > EVENT_LIMITS.cursor)) {
    problems.push(`"cursor" must be a cursor from a previous result`)
  }
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < PAGE.min || limit > PAGE.max)) {
    problems.push(`"limit" must be an integer from ${PAGE.min} to ${PAGE.max}`)
  }
  if (account !== undefined && (typeof account !== "string" || account.length === 0 || account.length > EVENT_LIMITS.account || hasControl(account))) {
    problems.push(`"account" must be a non-empty account name of at most ${EVENT_LIMITS.account} characters`)
  }
  if (source !== undefined && (typeof source !== "string" || source.length > EVENT_LIMITS.source || !SOURCE_PATTERN.test(source))) {
    problems.push(`"source" must be a source's name, a lowercase word such as gmail`)
  }
  if (scope !== undefined) problems.push(...scopeProblems(scope, `"scope"`))
  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    value: {
      ...(time === undefined ? {} : { since: time }),
      ...(cursor === undefined ? {} : { cursor: cursor as string }),
      limit: (limit as number | undefined) ?? PAGE.default,
      ...(account === undefined ? {} : { account: account as string }),
      ...(source === undefined ? {} : { source: source as string }),
      ...(scope === undefined ? {} : { scope: copyScope(scope as EventsScope) }),
    },
  }
}

/** Where a listing without a cursor starts: `since`, or `FIRST_RUN_HOURS` before `now`. */
export function startTime(request: Pick<EventsListRequest, "since">, now: number): number {
  return request.since ?? now - FIRST_RUN_HOURS * 3_600_000
}

// ── Cursor ──────────────────────────────────────────────────────────────

const CURSOR_VERSION = 1

/**
 * An opaque cursor for `source` holding `state`: base64url JSON that names the source, so another source's cursor is
 * refused. Throws when it would be longer than `EVENT_LIMITS.cursor`, a bug in the source.
 */
export function encodeCursor(source: string, state: Readonly<Record<string, unknown>>): string {
  const cursor = Buffer.from(JSON.stringify({ ...state, v: CURSOR_VERSION, s: source }), "utf8").toString("base64url")
  if (cursor.length > EVENT_LIMITS.cursor) throw new Error(`events-list: a ${source} cursor is ${cursor.length} characters, over ${EVENT_LIMITS.cursor}`)
  return cursor
}

/** The state `encodeCursor` stored for `source`; undefined when the cursor is malformed or another source's. */
export function decodeCursor(source: string, cursor: string): Record<string, unknown> | undefined {
  if (cursor.length === 0 || cursor.length > EVENT_LIMITS.cursor || !/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
  } catch {
    return undefined
  }
  if (!plainObject(parsed) || parsed["v"] !== CURSOR_VERSION || parsed["s"] !== source) return undefined
  const { v: _v, s: _s, ...state } = parsed
  return state
}

// ── Events ──────────────────────────────────────────────────────────────

/** At most `max` characters, ending in `…` when cut, never splitting a surrogate pair. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text
  let end = Math.max(0, max - 1)
  const code = text.charCodeAt(end - 1)
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end--
  return `${text.slice(0, end)}…`
}

/** `sha256:` and the hex digest of every field but the hash, in a fixed order. */
export function eventHash(event: Omit<SourceEvent, "hash">): string {
  const fields = [
    event.source,
    event.account,
    event.external_id,
    event.kind,
    event.occurred_at,
    event.thread,
    event.actors.map((actor) => [actor.role, actor.id, actor.name ?? null]),
    event.title,
    event.text,
    event.url,
    event.labels,
  ]
  return `sha256:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`
}

/** What a source fills in for `makeEvent`; it normalises the rest. */
export interface EventDraft {
  readonly source: string
  readonly account: string
  readonly external_id: string
  readonly kind: EventKind
  /** A Date, epoch milliseconds, or a string `Date.parse` reads. */
  readonly occurred_at: Date | number | string
  readonly thread?: string | null
  readonly actors?: readonly { readonly role: string; readonly id: string; readonly name?: string | null }[]
  readonly title?: string | null
  readonly text?: string | null
  readonly url?: string | null
  readonly labels?: readonly string[]
}

const clean = (text: string) => text.replaceAll("\u0000", "")
const oneLine = (text: string) => clean(text).replace(/\s+/g, " ").trim()

/**
 * A `SourceEvent` from a draft: the time in UTC ISO form, the title on one line and cut to 300 characters, the text cut
 * to 4096, actors without blanks or repeats and at most 20, labels likewise, a url only when it is https, and the hash.
 * Throws when the time is not a real time.
 */
export function makeEvent(draft: EventDraft): SourceEvent {
  const time = draft.occurred_at instanceof Date ? draft.occurred_at.getTime() : typeof draft.occurred_at === "number" ? draft.occurred_at : Date.parse(draft.occurred_at)
  if (!Number.isFinite(time)) throw new Error("events-list: an event's occurred_at is not a time")
  const seen = new Set<string>()
  const actors: EventActor[] = []
  for (const actor of draft.actors ?? []) {
    const role = oneLine(actor.role).toLowerCase()
    const id = oneLine(actor.id)
    const key = `${role}\u0000${id}`
    if (!role || !id || seen.has(key) || actors.length >= EVENT_LIMITS.actors) continue
    seen.add(key)
    const name = actor.name ? cut(oneLine(actor.name), EVENT_LIMITS.actorName) : ""
    actors.push(name ? { role, id, name } : { role, id })
  }
  const labels = [...new Set((draft.labels ?? []).map((label) => oneLine(label).replace(/\s/g, "-")).filter((label) => label.length > 0 && label.length <= EVENT_LIMITS.label))].slice(0, EVENT_LIMITS.labels)
  const url = draft.url && /^https:\/\/\S+$/.test(draft.url) && draft.url.length <= EVENT_LIMITS.url ? draft.url : null
  const thread = draft.thread ? oneLine(draft.thread) || null : null
  const event = {
    source: draft.source,
    account: draft.account,
    external_id: draft.external_id,
    kind: draft.kind,
    occurred_at: new Date(time).toISOString(),
    thread,
    actors,
    title: cut(oneLine(draft.title ?? ""), EVENT_LIMITS.title),
    text: cut(clean(draft.text ?? "").trim(), EVENT_LIMITS.text),
    url,
    labels,
  }
  return { ...event, hash: eventHash(event) }
}

/** Events oldest first; events at the same time keep their order. */
export function oldestFirst<T extends Pick<SourceEvent, "occurred_at">>(events: readonly T[]): T[] {
  return events
    .map((event, index) => ({ event, index, time: Date.parse(event.occurred_at) }))
    .sort((a, b) => a.time - b.time || a.index - b.index)
    .map(({ event }) => event)
}

/**
 * How many of `events`, in the order given, fit in one result: at most `limit`, and as many as keep the result's JSON
 * within `MAX_PAGE_BYTES`, but always at least one, since one event is far smaller than that.
 */
export function fitPage(events: readonly SourceEvent[], limit: number): number {
  let bytes = 2_048
  let count = 0
  for (const event of events) {
    if (count >= limit) break
    bytes += Buffer.byteLength(JSON.stringify(event)) + 1
    if (count > 0 && bytes > MAX_PAGE_BYTES) break
    count++
  }
  return count
}

/** Whose a page is: the contract source id, the account, the signed-in owner and the scope read. */
export interface EventsListIdentity {
  readonly source: string
  readonly account: string
  readonly owner: EventsOwner
  readonly scope: EventsScope
}

/** This plugin's package name, which every page names as `plugin`. */
export const PLUGIN_PACKAGE = "@joe-broadhead/opencode-gws"

/** What one page adds beyond its identity: the time, the drops, the gap and the cost. */
export interface PageExtras {
  readonly now: number
  readonly refused?: readonly RefusedDrop[]
  readonly failed?: readonly FailedDrop[]
  readonly gap?: EventsGap
  readonly cost?: Readonly<Record<string, unknown>>
}

/** A page, with its attribution, its drops and the time it read. */
export function eventsListResult(identity: EventsListIdentity, events: readonly SourceEvent[], cursor: string, more: boolean, extras: PageExtras): EventsListResult {
  return {
    source: identity.source,
    account: identity.account,
    owner: identity.owner,
    scope: copyScope(identity.scope),
    plugin: PLUGIN_PACKAGE,
    asOf: new Date(extras.now).toISOString(),
    events: [...events],
    cursor,
    more,
    trust: TRUST,
    refused: [...(extras.refused ?? [])],
    failed: [...(extras.failed ?? [])],
    ...(extras.gap === undefined ? {} : { gap: { ...extras.gap } }),
    ...(extras.cost === undefined ? {} : { cost: { ...extras.cost } }),
  }
}

// ── Checks ──────────────────────────────────────────────────────────────

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const ROLE = /^[a-z][a-z0-9_-]*$/
const SCHEMED = /^[a-z][a-z0-9+.-]*:\S+$/
const HASH = /^sha256:[0-9a-f]{64}$/

const text = (value: unknown, max: number, empty = false): value is string =>
  typeof value === "string" && value.length <= max && (empty || value.length > 0) && !value.includes("\u0000")
const line = (value: unknown, max: number, empty = false): value is string => text(value, max, empty) && !hasControl(value)

/** One event's problems, one sentence each; none when it keeps the contract. */
export function eventProblems(event: unknown, where = "event"): string[] {
  if (!plainObject(event)) return [`${where} is not an object`]
  const problems: string[] = []
  const keys = ["source", "account", "external_id", "kind", "occurred_at", "thread", "actors", "title", "text", "url", "labels", "hash"]
  for (const key of Object.keys(event)) if (!keys.includes(key)) problems.push(`${where} has the field "${key}", which the contract does not define`)
  for (const key of keys) if (!Object.hasOwn(event, key)) problems.push(`${where} has no "${key}"`)
  const e = event as Record<string, unknown>
  if (!line(e.source, EVENT_LIMITS.source) || !SOURCE_PATTERN.test(e.source)) problems.push(`${where}.source must be a lowercase name such as gmail`)
  if (!line(e.account, EVENT_LIMITS.account)) problems.push(`${where}.account must be a non-empty name of at most ${EVENT_LIMITS.account} characters`)
  if (!line(e.external_id, EVENT_LIMITS.externalId)) problems.push(`${where}.external_id must be a non-empty id of at most ${EVENT_LIMITS.externalId} characters`)
  if (!(EVENT_KINDS as readonly unknown[]).includes(e.kind)) problems.push(`${where}.kind must be one of ${EVENT_KINDS.join(", ")}`)
  if (typeof e.occurred_at !== "string" || !ISO_UTC.test(e.occurred_at) || !Number.isFinite(Date.parse(e.occurred_at))) {
    problems.push(`${where}.occurred_at must be a UTC ISO date-time ending in Z`)
  }
  if (e.thread !== null && !line(e.thread, EVENT_LIMITS.thread)) problems.push(`${where}.thread must be null or a non-empty id of at most ${EVENT_LIMITS.thread} characters`)
  if (!line(e.title, EVENT_LIMITS.title, true)) problems.push(`${where}.title must be one line of at most ${EVENT_LIMITS.title} characters`)
  if (!text(e.text, EVENT_LIMITS.text, true)) problems.push(`${where}.text must be at most ${EVENT_LIMITS.text} characters`)
  if (e.url !== null && (typeof e.url !== "string" || e.url.length > EVENT_LIMITS.url || !/^https:\/\/\S+$/.test(e.url))) problems.push(`${where}.url must be null or an https URL`)
  if (!Array.isArray(e.labels) || e.labels.length > EVENT_LIMITS.labels || e.labels.some((label) => !line(label, EVENT_LIMITS.label) || /\s/.test(label))) {
    problems.push(`${where}.labels must be at most ${EVENT_LIMITS.labels} labels of at most ${EVENT_LIMITS.label} characters without spaces`)
  } else if (new Set(e.labels).size !== e.labels.length) problems.push(`${where}.labels repeats a label`)
  if (!Array.isArray(e.actors) || e.actors.length > EVENT_LIMITS.actors) problems.push(`${where}.actors must be a list of at most ${EVENT_LIMITS.actors}`)
  else {
    const seen = new Set<string>()
    for (const [index, actor] of (e.actors as unknown[]).entries()) {
      const at = `${where}.actors[${index}]`
      if (!plainObject(actor)) {
        problems.push(`${at} is not an object`)
        continue
      }
      for (const key of Object.keys(actor)) if (!["role", "id", "name"].includes(key)) problems.push(`${at} has the field "${key}", which the contract does not define`)
      if (!line(actor.role, EVENT_LIMITS.actorRole) || !ROLE.test(actor.role)) problems.push(`${at}.role must be a lowercase word such as from`)
      if (!line(actor.id, EVENT_LIMITS.actorId) || !SCHEMED.test(actor.id)) problems.push(`${at}.id must be a scheme-qualified id such as mailto:someone@example.com`)
      if (actor.name !== undefined && !line(actor.name, EVENT_LIMITS.actorName)) problems.push(`${at}.name must be one non-empty line of at most ${EVENT_LIMITS.actorName} characters`)
      const key = `${String(actor.role)}\u0000${String(actor.id)}`
      if (seen.has(key)) problems.push(`${at} repeats an actor`)
      seen.add(key)
    }
  }
  if (typeof e.hash !== "string" || !HASH.test(e.hash)) problems.push(`${where}.hash must be sha256: and 64 hex digits`)
  else if (problems.length === 0) {
    const { hash, ...rest } = e as unknown as SourceEvent
    if (eventHash(rest) !== hash) problems.push(`${where}.hash is not the eventHash of its fields`)
  }
  return problems
}

/** A result's problems: its shape, every event, the order, the limit, the scope, the gap and the size. None when it keeps the contract. */
export function resultProblems(result: unknown, limit: number = PAGE.max, now = Date.now()): string[] {
  if (!plainObject(result)) return ["the result is not an object"]
  const problems: string[] = []
  const keys = ["source", "account", "owner", "scope", "plugin", "asOf", "events", "cursor", "more", "trust", "refused", "failed", "gap", "cost"]
  for (const key of Object.keys(result)) if (!keys.includes(key)) problems.push(`the result has the field "${key}", which the contract does not define`)
  const { source, account } = result
  const named = line(source, EVENT_LIMITS.source) && SOURCE_ID_PATTERN.test(source)
  if (!named) problems.push("the result's source must be a contract source id such as gws.gmail")
  if (!line(account, EVENT_LIMITS.account)) problems.push(`the result's account must be a non-empty name of at most ${EVENT_LIMITS.account} characters`)
  const owner = result["owner"]
  if (!plainObject(owner) || !line(owner["id"], EVENT_LIMITS.ownerId) || !line(owner["label"], EVENT_LIMITS.ownerLabel) || Object.keys(owner).some((key) => key !== "id" && key !== "label")) {
    problems.push("the result's owner must be { id, label }, two non-empty lines")
  }
  problems.push(...scopeProblems(result["scope"], "the result's scope"))
  for (const [key, field] of [["refused", "reason"], ["failed", "code"]] as const) {
    const drops = result[key]
    if (!Array.isArray(drops)) {
      problems.push(`the result's ${key} must be a list`)
      continue
    }
    for (const [index, drop] of drops.entries()) {
      if (!plainObject(drop) || !line(drop["external_id"], EVENT_LIMITS.externalId) || !line(drop[field], 200)) problems.push(`the result's ${key}[${index}] must be { external_id, ${field} }`)
    }
  }
  if (result["gap"] !== undefined) problems.push(...gapProblems(result["gap"], now))
  if (typeof result["plugin"] !== "string" || result["plugin"].length === 0) problems.push("the result's plugin must be the package name")
  if (typeof result["asOf"] !== "string" || !Number.isFinite(Date.parse(result["asOf"]))) problems.push("the result's asOf must be an ISO date-time")
  const cursor = result["cursor"]
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > EVENT_LIMITS.cursor) problems.push(`the result's cursor must be a non-empty string of at most ${EVENT_LIMITS.cursor} characters`)
  if (typeof result["more"] !== "boolean") problems.push("the result's more must be true or false")
  if (result["trust"] !== TRUST) problems.push(`the result's trust must be "${TRUST}"`)
  const events = result["events"]
  if (!Array.isArray(events)) return [...problems, "the result's events must be a list"]
  if (events.length > limit) problems.push(`the result has ${events.length} events, over the limit of ${limit}`)
  for (const [index, event] of events.entries()) {
    problems.push(...eventProblems(event, `events[${index}]`))
    if (plainObject(event) && typeof account === "string" && event["account"] !== account) problems.push(`events[${index}] names another account than the result`)
  }
  const times = events.map((event) => Date.parse(plainObject(event) ? String(event["occurred_at"]) : ""))
  if (times.some((time, index) => index > 0 && time < times[index - 1]!)) problems.push("the result's events are not oldest first")
  const ids = events.map((event) => (plainObject(event) ? `${String(event["source"])}:${String(event["account"])}:${String(event["external_id"])}` : ""))
  if (new Set(ids).size !== ids.length) problems.push("the result lists one event twice")
  const bytes = Buffer.byteLength(JSON.stringify(result))
  if (bytes > MAX_PAGE_BYTES) problems.push(`the result is ${bytes} bytes of JSON, over ${MAX_PAGE_BYTES}`)
  return problems
}

// The conformance kit is the source-contract package's: `conformance` (vendored under vendor/).
