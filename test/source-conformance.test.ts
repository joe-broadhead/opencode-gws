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
import { encodeCursor, PLUGIN_PACKAGE } from "../src/host/events-list.js"
import { GMAIL_SOURCE, GMAIL_SOURCE_ID, gmailMessageEvent } from "../src/host/gmail-events.js"
import type { PermissionRequest } from "../src/host/permissions.js"
import { type Call, parse, toolSpecs } from "../src/host/tools.js"
import type { Runtime } from "../src/runtime/index.js"
import { account, testRuntime } from "./support/config.js"

/**
 * The source-contract conformance kit, vendored from the package at commit 3fe6255 (`vendor/VENDOR.md`), run against
 * the plugin's declaration and its real reads through the tool specs. The Gmail source runs every check; Calendar's
 * kit case is pending the package's `atomicPages` option (a page cannot hold `failed[]` when the provider read is
 * atomic), and is skipped with that reason.
 */

const GMAIL_FIXTURE = fileURLToPath(new URL("./fixtures/gmail-source.json", import.meta.url))
const SINCE = "2026-11-01T00:00:00Z"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  sources: { contractVersion: number; items: Array<Record<string, unknown> & { id: string }> }
}
const sourceOf = (id: string) => pkg.sources.items.find((item) => item.id === id)!

let dir: string
let mailboxPath: string
const runtimes: Runtime[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-gws-source-"))
  mailboxPath = join(dir, "mailbox.json")
  copyFileSync(GMAIL_FIXTURE, mailboxPath)
  process.env["FAKE_GWS_MAILBOX"] = mailboxPath
})

afterEach(async () => {
  delete process.env["FAKE_GWS_MAILBOX"]
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
  source: GMAIL_SOURCE_ID,
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

  it.skip("passes the conformance kit for Calendar once the kit's atomicPages lands (source-contract#13)", () => {
    // Calendar's page read is atomic: one provider read, so a page has no per-event failed[] to demonstrate. The kit's
    // `failed-holds-cursor` and `refused-is-final` checks need `atomicPages: { reason }`, which is landing on PR #13.
    expect(CALENDAR_SOURCE).toBe("calendar")
  })
})

