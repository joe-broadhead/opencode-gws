import { GwsError } from "../domain/errors.js"
import { type GmailMessage, MESSAGE_FIELDS, type MessageFacts, NOISE_QUERY, isNoise, messageFacts } from "../domain/gmail.js"
import type { CallContext } from "../runtime/accounts.js"
import type { Runtime } from "../runtime/index.js"
import { screenEvents, secretKinds } from "../../vendor/source-contract-dist/events.js"
import {
  type FailedDrop,
  type RefusedDrop,
  type EventsListRequest,
  type EventsListResult,
  type SourceEvent,
  decodeCursor,
  encodeBoundCursor,
  decodeBoundCursor,
  eventsListResult,
  fitPage,
  makeEvent,
  oldestFirst,
  startTime,
} from "./events-list.js"
import { rememberOwner } from "./identity.js"

/**
 * events_list for Gmail: the messages that arrived since a cursor, as the source contract's events (version 1).
 *
 * - A listing searches `messages.list` for everything after `since` (or the last event's time), then follows
 *   `history.list` from the mailbox's history id, listing oldest first.
 * - A message whose `messages.get` fails with a provider error is a `failed[]` entry, and the cursor stays before it:
 *   the page is not failed, and the next call retries that message.
 * - Every event is screened with the package's secret detector: a secret-shaped message goes to `refused[]`, with its
 *   reason, and never into `events`.
 * - The identity is remembered for `probe`, so probe reads no content.
 * - The cursor is bound to the source and account; another binding's cursor is `CURSOR_INVALID`.
 */

/** The `source` input that names Gmail. */
export const GMAIL_SOURCE = "gmail"

/** The contract source id a page names. */
export const GMAIL_SOURCE_ID = "gws.gmail"

/** Every content read events_list makes. */
export const GMAIL_READS = ["gmail.users.getProfile", "gmail.users.history.list", "gmail.users.messages.list", "gmail.users.messages.get"] as const

/** The operation `gws.events_list` is asserted on: the one the listing follows. */
export const GMAIL_FOLLOW = "gmail.users.history.list"

/** The identity operation `probe` reports; the pages assert it as a content operation because they read it. */
export const GMAIL_IDENTITY = "gmail.users.getProfile"

/** Ids per messages.list or history.list page. */
const PAGE_SIZE = 500
/** The most messages.list pages the first listing reads. */
const SEARCH_PAGES = 20
/** The most history.list pages one call reads. */
const HISTORY_PAGES = 5
/** messages.get calls at once. */
const FETCHES = 4

const METADATA_FIELDS = "id,threadId,labelIds,snippet,internalDate,payload(headers(name,value))"

/** Searching messages after `t` (epoch ms); `l` is the last message listed. */
interface Search {
  readonly p: "s"
  readonly t: number
  readonly l?: string
}

/** Following history from record `h`, of whose added messages the first `n` are listed. */
interface Follow {
  readonly p: "h"
  readonly h: string
  readonly n: number
  readonly t: number
}

type State = Search | Follow

/** A message to fetch, and where the listing stands once it is listed. */
interface Candidate {
  readonly id: string
  readonly after: State
}

type Data = Record<string, unknown>

const record = (value: unknown): Data => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Data) : {})
const list = (value: unknown): Data[] => (Array.isArray(value) ? value.map(record) : [])
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [])
const historyId = (value: unknown): string | undefined =>
  typeof value === "string" && /^\d{1,20}$/.test(value) ? BigInt(value).toString() : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined
const step = (id: string, by: bigint) => {
  const value = BigInt(id) + by
  return (value < 0n ? 0n : value).toString()
}
const before = (a: string, b: string) => BigInt(a) < BigInt(b)

/** The cursor binding: the plugin prefix, the source, the account and the (empty) scope. */
function bindingOf(account: string): { plugin: string; source: string; account: string; scope: Record<string, string[]> } {
  return { plugin: "gws", source: GMAIL_SOURCE, account, scope: {} }
}

/** The state a cursor holds, when this source and account issued it. A contract-1 cursor is accepted once. */
function stateOf(cursor: string, account: string): State {
  const decoded = decodeBoundCursor(bindingOf(account), cursor, { acceptV1: true })
  const state = decoded.ok ? decoded.state : decodeCursor(GMAIL_SOURCE, cursor)
  const refuse = () => new GwsError("CURSOR_INVALID", "the cursor was not issued by gws for this source and account", { next: "Read again without a cursor to restart the window." })
  if (!state || state["a"] !== account) throw refuse()
  const { p, t } = state
  if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 0) throw refuse()
  if (p === "s") {
    const l = state["l"]
    if (l !== undefined && typeof l !== "string") throw refuse()
    return { p, t, ...(typeof l === "string" ? { l } : {}) }
  }
  const h = historyId(state["h"])
  const n = state["n"]
  if (p !== "h" || !h || typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw refuse()
  return { p, h, n, t }
}

/** `work` over each item, at most `limit` at once, the results in the items' order. */
async function each<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** One message as a contract event. */
function toEvent(facts: MessageFacts, account: string): SourceEvent {
  const thread = facts.threadId ? encodeURIComponent(facts.threadId) : undefined
  return makeEvent({
    source: GMAIL_SOURCE,
    account,
    kind: "message",
    external_id: facts.id,
    occurred_at: facts.time,
    thread: thread ? `gmail-thread:${thread}` : null,
    actors: facts.people.map((person) => ({ role: person.role, id: `mailto:${person.address}`, ...(person.name ? { name: person.name } : {}) })),
    title: facts.subject,
    text: facts.text,
    url: thread ? `https://mail.google.com/mail/u/0/#all/${thread}` : null,
    labels: facts.labels,
  })
}

/** One message's event, from the message `messages.get` answers (the declared detail read). */
export function gmailMessageEvent(message: GmailMessage, account: string): SourceEvent | undefined {
  const facts = messageFacts(message)
  return facts === undefined ? undefined : toEvent(facts, account)
}

/**
 * Lists the Gmail messages of `account` after the request's cursor, or since its `since`.
 */
export async function gmailEvents(runtime: Pick<Runtime, "read">, account: string, request: EventsListRequest, ctx: CallContext, now = Date.now()): Promise<EventsListResult> {
  const read = async (operation: string, params: Data, fields: string): Promise<Data> =>
    record((await runtime.read({ account, operation, params: { userId: "me", ...params }, fields }, ctx)).data)
  const status = (error: unknown) => GwsError.from(error)?.status

  const profile = await read("gmail.users.getProfile", {}, "emailAddress,historyId")
  const address = typeof profile["emailAddress"] === "string" ? profile["emailAddress"].trim().toLowerCase() : ""
  const head = historyId(profile["historyId"])
  if (!address || !head) throw new GwsError("GWS_API_ERROR", "Gmail's profile answered without the account's address or history id")
  const owner = { id: `mailto:${address}`, label: address }
  rememberOwner(runtime, GMAIL_SOURCE, account, owner)

  const scope = request.scope ?? {}
  if (Object.keys(scope).length > 0) {
    throw new GwsError("GWS_VALIDATION_ERROR", "Gmail has no scope: events_list reads the signed-in mailbox whole", { next: "Call events_list without scope." })
  }
  const identity = { source: GMAIL_SOURCE, account, owner, scope }
  let state: State = request.cursor === undefined ? { p: "s", t: startTime(request, now) } : stateOf(request.cursor, account)
  // The deprecated owner-only call: the identity and the cursor, and not one message read.
  if (request.limit === 0) return eventsListResult(identity, [], encodeBoundCursor(bindingOf(account), { a: account, ...state }), false, { now })

  const searched = new Map<number, string[]>()
  const search = async (t: number): Promise<string[]> => {
    const known = searched.get(t)
    if (known) return known
    const ids: string[] = []
    let pageToken: string | undefined
    for (let page = 0; page < SEARCH_PAGES; page++) {
      const q = `after:${Math.max(0, Math.floor(t / 1000) - 1)} ${NOISE_QUERY}`
      const data = await read("gmail.users.messages.list", { q, maxResults: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) }, "messages(id),nextPageToken")
      ids.push(...list(data["messages"]).flatMap((message) => (typeof message["id"] === "string" ? [message["id"]] : [])))
      pageToken = typeof data["nextPageToken"] === "string" ? data["nextPageToken"] : undefined
      if (!pageToken) {
        const found = [...new Set(ids)].reverse()
        searched.set(t, found)
        return found
      }
    }
    throw new GwsError("GWS_VALIDATION_ERROR", `more than ${SEARCH_PAGES * PAGE_SIZE} messages arrived after since`, { next: "Call events_list again with a later since." })
  }

  const follow = async (from: Follow, room: number): Promise<{ added: Candidate[]; state: Follow; more: boolean } | "expired"> => {
    const added: Candidate[] = []
    let state = from
    let pageToken: string | undefined
    for (let page = 0; page < HISTORY_PAGES; page++) {
      let data: Data
      try {
        const params = { startHistoryId: step(from.h, -1n), historyTypes: "messageAdded", maxResults: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) }
        data = await read("gmail.users.history.list", params, "history(id,messagesAdded(message(id,labelIds))),historyId,nextPageToken")
      } catch (error) {
        if (page === 0 && status(error) === 404) return "expired"
        throw error
      }
      for (const entry of list(data["history"])) {
        const id = historyId(entry["id"])
        if (!id || before(id, state.h)) continue
        const messages = list(entry["messagesAdded"]).map((added) => record(added["message"]))
        for (let index = id === state.h ? state.n : 0; index < messages.length; index++) {
          if (added.length >= room) return { added, state, more: true }
          const message = messages[index]!
          state = { p: "h", h: id, n: index + 1, t: state.t }
          if (typeof message["id"] === "string" && !isNoise(strings(message["labelIds"]))) added.push({ id: message["id"], after: state })
        }
        state = { p: "h", h: step(id, 1n), n: 0, t: state.t }
      }
      pageToken = typeof data["nextPageToken"] === "string" ? data["nextPageToken"] : undefined
      if (!pageToken) {
        const current = historyId(data["historyId"])
        if (current && before(state.h, step(current, 1n))) state = { p: "h", h: step(current, 1n), n: 0, t: state.t }
        return { added, state, more: false }
      }
    }
    return { added, state, more: true }
  }

  const candidates: Candidate[] = []
  let more = false
  let fellBack = false
  let gap: { reason: "expired" | "window-truncated"; since: string } | undefined
  while (candidates.length < request.limit) {
    if (state.p === "s") {
      const ids = await search(state.t)
      const start = state.l === undefined ? 0 : ids.indexOf(state.l) + 1
      const take = ids.slice(start, start + request.limit - candidates.length)
      for (const id of take) {
        state = { ...state, l: id }
        candidates.push({ id, after: state })
      }
      if (start + take.length < ids.length) {
        more = true
        break
      }
      state = { p: "h", h: step(head, 1n), n: 0, t: state.t }
      continue
    }
    const followed = await follow(state, request.limit - candidates.length)
    if (followed === "expired") {
      if (fellBack) throw new GwsError("GWS_API_ERROR", "Gmail refused a history id it had just given")
      fellBack = true
      gap = { reason: "expired", since: new Date(Math.max(state.t, now - 31 * 86_400_000 + 60_000)).toISOString() }
      state = { p: "s", t: state.t }
      continue
    }
    candidates.push(...followed.added)
    state = followed.state
    more = followed.more
    break
  }

  const fetched = await each(candidates, FETCHES, async (candidate): Promise<{ event?: SourceEvent; failed?: FailedDrop }> => {
    const get = (fields: string, format: string) => read("gmail.users.messages.get", { id: candidate.id, format }, fields) as Promise<GmailMessage>
    try {
      const facts = messageFacts(await get(MESSAGE_FIELDS, "full"))
      return facts === undefined ? { failed: { external_id: candidate.id, code: "SCHEMA_VIOLATION" } } : { event: toEvent(facts, account) }
    } catch (error) {
      const known = GwsError.from(error)
      if (known?.status === 404) return {}
      if (known?.code === "OUTPUT_LIMIT") {
        const facts = messageFacts(await get(METADATA_FIELDS, "metadata"))
        return facts === undefined ? { failed: { external_id: candidate.id, code: "SCHEMA_VIOLATION" } } : { event: toEvent(facts, account) }
      }
      return { failed: { external_id: candidate.id, code: "UNAVAILABLE" } }
    }
  })

  const listed: Array<{ event: SourceEvent; after: State }> = []
  const refused: RefusedDrop[] = []
  const failed: FailedDrop[] = []
  for (const [index, result] of fetched.entries()) {
    const candidate = candidates[index]!
    if (result.failed !== undefined) {
      failed.push(result.failed)
      // failed[] holds the cursor back: it stays before this message, so the next call retries it.
      break
    }
    if (result.event !== undefined) {
      const screened = screenEvents([result.event], { secrets: secretKinds })
      if (screened.refused.length > 0) {
        const drop = screened.refused[0]!
        refused.push({ external_id: drop.external_id, reason: drop.reason })
        continue
      }
      listed.push({ event: result.event, after: candidate.after })
      state = candidate.after
    } else {
      state = candidate.after
    }
  }
  if (failed.length > 0) more = true
  const kept = fitPage(listed.map((item) => item.event), request.limit)
  if (kept < listed.length) {
    state = listed[kept - 1]!.after
    more = true
  }
  // failed[] holds the cursor back: the page answers the cursor it was given (empty on a first call), never a later one.
  const cursor = failed.length > 0 ? (request.cursor ?? "") : encodeBoundCursor(bindingOf(account), { a: account, ...state })
  return eventsListResult(identity, oldestFirst(listed.slice(0, kept).map((item) => item.event)), cursor, more, { now, gap, refused, failed })
}

