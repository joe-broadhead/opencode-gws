import { createHash } from "node:crypto"
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { sourceConformance, type ConformanceReport } from "../vendor/source-contract-dist/conformance.js"
import { SOURCES_SCHEMA } from "../vendor/source-contract-dist/schema.js"
import { EventsListInput, ProbeInput, RequestInput } from "../src/domain/contract.js"
import { type GmailMessage, MESSAGE_FIELDS } from "../src/domain/gmail.js"
import { CALENDAR_SOURCE } from "../src/host/calendar-events.js"
import { decodeBoundCursor, encodeBoundCursor, encodeCursor, PLUGIN_PACKAGE } from "../src/host/events-list.js"
import { GMAIL_SOURCE, gmailMessageEvent } from "../src/host/gmail-events.js"
import type { PermissionRequest } from "../src/host/permissions.js"
import { type Call, parse, toolSpecs } from "../src/host/tools.js"
import type { Runtime } from "../src/runtime/index.js"
import { account, testRuntime } from "./support/config.js"

/**
 * The source-contract conformance kit, vendored from PR #17 head e5a3fef (`vendor/VENDOR.md`), run against the plugin's
 * declaration and its real reads through the tool specs. Both sources pass; Calendar declares `atomicPages`, because
 * `calendar.events.list` is one provider read and its page cannot hold a per-event failure.
 */

const GMAIL_FIXTURE = fileURLToPath(new URL("./fixtures/gmail-source.json", import.meta.url))
const CALENDAR_FIXTURE = fileURLToPath(new URL("./fixtures/calendar-mailbox.json", import.meta.url))
const SINCE = "2026-11-01T00:00:00Z"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  sources: { contractVersion: number; items: Array<Record<string, unknown> & { id: string }> }
}
const sourceOf = (id: string) => pkg.sources.items.find((item) => item.id === id)!

let dir: string
let mailboxPath: string
let calendarPath: string
const runtimes: Runtime[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-gws-source-"))
  mailboxPath = join(dir, "mailbox.json")
  copyFileSync(GMAIL_FIXTURE, mailboxPath)
  calendarPath = join(dir, "calendar.json")
  copyFileSync(CALENDAR_FIXTURE, calendarPath)
  process.env["FAKE_GWS_MAILBOX"] = mailboxPath
  process.env["FAKE_GWS_CALENDAR"] = calendarPath
})

afterEach(async () => {
  delete process.env["FAKE_GWS_MAILBOX"]
  delete process.env["FAKE_GWS_CALENDAR"]
  for (const runtime of runtimes.splice(0)) await runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

type Permission = { assert(input: { action: string; resources?: readonly string[] }): Promise<void> }

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16)

function harness(runtime: Runtime) {
  let active: Permission = { assert: async () => {} }
  const specs = toolSpecs(
    runtime,
    async (request: PermissionRequest) => active.assert(request),
    async () => {
      throw new Error("the source contract does not read status")
    },
  )
  const call = (): Call => ({
    host: { sessionID: "ses_conformance", agent: "build", messageID: "msg_1", id: "call_1" },
    runtime: { sessionId: "ses_conformance", agentId: "build", signal: new AbortController().signal },
  })
  const run = async (name: string, schema: Parameters<typeof parse>[0], input: unknown, permission: Permission): Promise<unknown> => {
    active = permission
    const spec = specs.find((candidate) => candidate.name === name)!
    return (await spec.run(parse(schema, input), call())).output
  }
  return { run }
}

const detailPage = (account: string, events: unknown[]): Record<string, unknown> => ({
  source: GMAIL_SOURCE,
  account,
  owner: { id: account, label: account },
  scope: {},
  plugin: PLUGIN_PACKAGE,
  asOf: new Date().toISOString(),
  events,
  cursor: "",
  more: false,
  trust: "untrusted",
  refused: [],
  failed: [],
})

async function gmailReport(): Promise<ConformanceReport> {
  const runtime = await testRuntime({ accounts: { personal: account({ services: ["gmail", "calendar"] }) } })
  runtimes.push(runtime)
  const { run } = harness(runtime)
  const mailbox = JSON.parse(readFileSync(mailboxPath, "utf8")) as { emailAddress: string }
  const expired = encodeCursor(GMAIL_SOURCE, { a: "personal", o: digest(mailbox.emailAddress), p: "h", h: "1", n: 0, t: Date.parse("2026-11-06T00:00:00Z") })
  return sourceConformance({
    plugin: PLUGIN_PACKAGE,
    source: sourceOf("gws.gmail") as never,
    tools: [
      { id: "events_list", readOnly: true },
      { id: "read", readOnly: true },
      { id: "probe", readOnly: true },
    ],
    calls: {
      list: (input, context) => run("events_list", EventsListInput, input, context.permission) as Promise<unknown>,
      probe: (input, context) => run("probe", ProbeInput, input, context.permission) as Promise<unknown>,
      details: {
        "gws.gmail.message": async (input, context) => {
          const answer = (await run(
            "read",
            RequestInput,
            { account: input.account, operation: "gmail.users.messages.get", params: { id: input.fields["external_id"], format: "full" }, fields: MESSAGE_FIELDS },
            context.permission,
          )) as { data: GmailMessage }
          const event = gmailMessageEvent(answer.data, input.account)
          return detailPage(input.account, event === undefined ? [] : [event])
        },
      },
    },
    cases: [
      { name: "a page of messages", input: { source: "gmail", account: "personal", since: SINCE, limit: 500 }, expect: "page" },
      { name: "a foreign cursor", input: { source: "gmail", account: "personal", cursor: "not-a-cursor" }, expect: { refuses: "CURSOR_INVALID" } },
      { name: "an expired history", input: { source: "gmail", account: "personal", cursor: expired }, expect: "expired" },
    ],
    detailCases: [{ id: "gws.gmail.message", event: { external_id: "18f0000000000001" } }],
    identityOperations: [],
    account: "personal",
  })
}

async function calendarReport(): Promise<ConformanceReport> {
  const runtime = await testRuntime({ accounts: { personal: account({ services: ["gmail", "calendar"] }) } })
  runtimes.push(runtime)
  const { run } = harness(runtime)
  const expired = encodeCursor(CALENDAR_SOURCE, { a: "personal", o: digest("sam.rivera@example.com"), k: "s", y: "sync-expired", w: 0, t: Date.parse(SINCE), n: 0 })
  return sourceConformance({
    plugin: PLUGIN_PACKAGE,
    source: sourceOf("gws.calendar") as never,
    tools: [
      { id: "events_list", readOnly: true },
      { id: "read", readOnly: true },
      { id: "probe", readOnly: true },
    ],
    calls: {
      list: (input, context) => run("events_list", EventsListInput, { source: "calendar", ...input }, context.permission) as Promise<unknown>,
      probe: (input, context) => run("probe", ProbeInput, input, context.permission) as Promise<unknown>,
    },
    cases: [
      { name: "a page of events", input: { source: "calendar", account: "personal", since: SINCE, limit: 500 }, expect: "page" },
      { name: "an expired sync token", input: { source: "calendar", account: "personal", cursor: expired }, expect: "expired" },
    ],
    identityOperations: [],
    account: "personal",
    atomicPages: { reason: "calendar.events.list is one provider read, so a page has no per-event failure" },
  })
}

describe("the source contract", () => {
  it("validates the declaration the plugin ships", () => {
    const checked = SOURCES_SCHEMA.check(pkg.sources)
    expect(checked.ok ? [] : checked.problems).toEqual([])
    expect(pkg.sources.contractVersion).toBe(1)
    expect(pkg.sources.items.map((item) => item.id)).toEqual(["gws.gmail", "gws.calendar"])
  })

  it("passes the conformance kit for Gmail, refusals and retryable drops included", async () => {
    const report = await gmailReport()
    expect(report.problems).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.checks.filter((check) => !check.ran && !check.notApplicable).map((check) => check.name)).toEqual([])
  }, 60_000)

  it("accepts a contract-1 cursor once and answers a bound one", async () => {
    const runtime = await testRuntime({ accounts: { personal: account({ services: ["gmail", "calendar"] }) } })
    runtimes.push(runtime)
    const { run } = harness(runtime)
    const mailbox = JSON.parse(readFileSync(mailboxPath, "utf8")) as { emailAddress: string }
    const legacy = encodeCursor(GMAIL_SOURCE, { a: "personal", o: digest(mailbox.emailAddress), p: "s", t: Date.parse("2026-11-06T00:00:00Z") })
    const page = (await run("events_list", EventsListInput, { source: "gmail", account: "personal", cursor: legacy }, { assert: async () => {} })) as { cursor: string }
    const decoded = decodeBoundCursor({ plugin: "gws", source: "gmail", account: "personal", scope: {} }, page.cursor)
    expect(decoded.ok).toBe(true)
    expect(decoded.ok && decoded.legacy).toBe(false)
    // A cursor bound to another account is refused.
    const foreign = encodeBoundCursor({ plugin: "gws", source: "gmail", account: "work", scope: {} }, { a: "work" })
    await expect(run("events_list", EventsListInput, { source: "gmail", account: "personal", cursor: foreign }, { assert: async () => {} })).rejects.toThrow(/CURSOR_INVALID/)
  }, 60_000)

  it("passes the conformance kit for Calendar, with atomicPages", async () => {
    const report = await calendarReport()
    expect(report.problems).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.checks.find((check) => check.name === "failed-holds-cursor")?.notApplicable).toBe(true)
  }, 60_000)
})

