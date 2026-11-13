/**
 * The `events_list` page this plugin answers: the source contract's page, plus this plugin's contract 2.
 *
 * The contract itself is the package's (`vendor/source-contract-dist/events.js` and `cursor.js`, vendored from
 * opencode-mem PR #17 head `e5a3fef`, `vendor/VENDOR.md`): the data model, `makeEvent`, `eventHash`, `fitPage`, the
 * secret screening, the checks, the conformance kit and both cursors. Nothing here restates them.
 *
 * Three things are this plugin's, because the package keeps contract 1's page where this plugin answers contract 2, as
 * Memory's collector needs it:
 *
 * - **`limit: 0`**, the owner-only call, which answers the identity and reads no content. The package refuses it.
 * - **The scope**, `{ calendars: ["primary"] }`, accepted for any key here and checked per source by the source itself
 *   (Gmail has none; Calendar has `calendars`), then echoed on every page exactly as the call named it. The package
 *   accepts a scope only under a declared key and would echo it canonicalised, so a page could not echo what was asked.
 * - **The page's lines**: `plugin`, `asOf`, `refused` and `failed` are on every page, empty lists included, as the tool
 *   schema `EventsListOutput` declares them. The package writes each one only when it is given, and leaves an empty
 *   `refused` or `failed` out.
 */
import {
  EVENT_LIMITS,
  PAGE,
  SOURCE_PATTERN,
  TRUST,
  type EventsCost,
  type EventsGap,
  type EventsOwner,
  type FailedEvent,
  type RefusedEvent,
  type SourceEvent,
  cut,
  sinceTime,
} from "../../vendor/source-contract-dist/events.js"

/** The package every page names. */
export const PLUGIN_PACKAGE = "@joe-broadhead/opencode-gws"

/**
 * What a call reads, as ids under the source's declared scope keys, such as `{ calendars: ["primary"] }`. A page
 * echoes it, so Memory can pin it to the person's confirmed scope. An empty object is the whole source.
 */
export type EventsScope = Readonly<Record<string, readonly string[]>>

/** `limit`'s default and inclusive range. `limit: 0` is contract 2's owner-only call: the identity, and no event. */
const LIMIT = { default: PAGE.default, min: 0, max: PAGE.max } as const

/** Contract 2: the most scope keys one call carries, the most ids under one key, and an id's longest form. */
const SCOPE = { keys: 8, ids: 64, id: 128 } as const

/** A scope key: a lowercase word such as `calendars`. */
const SCOPE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/

/** Contract 2's bound on a restarted window's `since`: the furthest back one may name. */
export const GAP_MAX_DAYS = 31

export interface EventsListRequest {
  readonly since?: number
  readonly cursor?: string
  readonly limit: number
  readonly account?: string
  readonly source?: string
  readonly scope?: EventsScope
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
  readonly refused: RefusedEvent[]
  /** Retryable drops: any entry holds the cursor back. */
  readonly failed: FailedEvent[]
  /** Present only when the source restarted its window; absent on an ordinary page. */
  readonly gap?: EventsGap
  /** What the provider reported; free sources omit it. */
  readonly cost?: EventsCost
}

/** A request without a scope key on its source is refused by the source, not here: Gmail has none, Calendar has one. */
const INPUT_KEYS: readonly string[] = ["since", "cursor", "limit", "account", "source", "scope"]
/** True when the text has a control character (U+0000 to U+001F, or U+007F). */
const hasControl = (text: string) => [...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)

const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * A scope's problems, one sentence each, naming keys and never ids. `where` names the scope in the sentence, such as
 * `"scope"` or `the result's scope`. A scope is at most `SCOPE.keys` keys, each a lowercase word, and under each
 * `SCOPE.ids` distinct ids of at most `SCOPE.id` characters.
 */
function scopeProblems(scope: unknown, where: string): string[] {
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
function copyScope(scope: EventsScope): Record<string, string[]> {
  return Object.fromEntries(Object.entries(scope).map(([key, ids]) => [key, [...ids]]))
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
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < LIMIT.min || limit > LIMIT.max)) {
    problems.push(`"limit" must be an integer from ${LIMIT.min} to ${LIMIT.max}`)
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
      limit: (limit as number | undefined) ?? LIMIT.default,
      ...(account === undefined ? {} : { account: account as string }),
      ...(source === undefined ? {} : { source: source as string }),
      ...(scope === undefined ? {} : { scope: copyScope(scope as EventsScope) }),
    },
  }
}

/** Whose a page is: the contract source id, the account, the signed-in owner and the scope read. */
export interface EventsListIdentity {
  readonly source: string
  readonly account: string
  readonly owner: EventsOwner
  readonly scope: EventsScope
}

/** What one page adds beyond its identity: the time, the drops, the gap and the cost. */
export interface PageExtras {
  readonly now: number
  readonly refused?: readonly RefusedEvent[]
  readonly failed?: readonly FailedEvent[]
  readonly gap?: EventsGap
  readonly cost?: EventsCost
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
