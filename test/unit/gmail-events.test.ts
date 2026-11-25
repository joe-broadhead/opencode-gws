import { describe, expect, it } from "vitest"
import { type EventsListResult, resultProblems } from "@we-the-rebel-alliance/plugin-contract/events"
import { GMAIL_SOURCE, gmailEvents } from "../../src/provider/sources/gmail-events.js"
import { PAGE_MAX_BYTES } from "../../src/provider/sources/page.js"

/**
 * Gmail's cursor is the provider's history record and, in the search fallback, the last provider id. Two messages can
 * share one `internalDate`; a cursor that resumed after the timestamp alone would skip the second. This walks a page
 * boundary with `limit: 1` and both messages at the same time.
 */
const NOW = Date.parse("2026-11-02T12:00:00.000Z")
const SINCE = Date.parse("2026-11-01T00:00:00Z")
const ACCOUNT = "work"

function message(id: string, at: string) {
  return {
    id,
    threadId: id,
    labelIds: ["INBOX"],
    snippet: `Synthetic ${id}`,
    internalDate: String(Date.parse(at)),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: `Sender <${id}@example.test>` },
        { name: "To", value: "ana@example.test" },
        { name: "Subject", value: `Subject ${id}` },
      ],
      body: { data: "" },
    },
  }
}

const AT = "2026-11-01T10:00:00.000Z"
const MESSAGES = new Map([
  ["msg_a", message("msg_a", AT)],
  ["msg_b", message("msg_b", AT)],
])

/** A runtime whose Gmail reads answer both ids at one timestamp; `messages.list` is newest first, as Gmail does. */
function runtime() {
  const calls: string[] = []
  return {
    calls,
    read: async (input: { operation: string; params?: Record<string, unknown> }) => {
      calls.push(input.operation)
      if (input.operation === "gmail.users.getProfile") {
        return { data: { emailAddress: "ana@example.test", historyId: "1000" } }
      }
      if (input.operation === "gmail.users.messages.list") {
        return { data: { messages: [{ id: "msg_b" }, { id: "msg_a" }] } }
      }
      if (input.operation === "gmail.users.messages.get") {
        const id = input.params?.["id"]
        const found = typeof id === "string" ? MESSAGES.get(id) : undefined
        if (found === undefined) throw new Error(`no message ${String(id)}`)
        return { data: found }
      }
      throw new Error(`unexpected operation ${input.operation}`)
    },
  }
}

const ctx = { sessionId: "session", agentId: "build", signal: new AbortController().signal }
const ids = (page: EventsListResult) => page.events.map((event) => event.external_id)

describe("Gmail events across a same-timestamp page boundary", () => {
  it("returns the second message after the first page's cursor, never skipping a shared timestamp", async () => {
    const gws = runtime()
    const first = await gmailEvents(gws as never, ACCOUNT, { since: SINCE, limit: 1 }, ctx, NOW)
    expect(ids(first)).toEqual(["msg_a"])
    expect(first.more).toBe(true)
    expect(first.source).toBe(GMAIL_SOURCE)
    expect(resultProblems(first, 1, PAGE_MAX_BYTES)).toEqual([])

    const second = await gmailEvents(gws as never, ACCOUNT, { cursor: first.cursor, limit: 1 }, ctx, NOW)
    expect(ids(second)).toEqual(["msg_b"])
    expect(second.more).toBe(false)
    expect(resultProblems(second, 1, PAGE_MAX_BYTES)).toEqual([])
  })
})
