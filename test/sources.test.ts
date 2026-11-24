import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { PluginMethod, ToolCall } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventsListOutput } from "../src/domain/contract.js"
import { GwsError } from "../src/domain/errors.js"
import { deprecatedNote, markCalendarTodayCalled, resetDeprecated } from "../src/host/deprecated.js"
import type { PermissionRequest } from "../src/host/permissions.js"
import { scriptMethods } from "../src/host/script-methods.js"
import { SHEETS_MAX_BYTES, SHEETS_OPERATION } from "../src/host/sheets.js"
import { IMAGE_DATA_URI_MAX } from "../src/host/sources.js"
import { Accounts, type RuntimeOptions } from "../src/runtime/accounts.js"
import type { Runtime } from "../src/runtime/index.js"
import { account, fakeTokens, testRuntime } from "./support/config.js"

/**
 * The source contract's reads that are tools RPC methods only, beyond what the conformance kit proves
 * (test/source-conformance.test.ts): probe's refusals and scopes, events_list's Calendar source across syncs,
 * calendar_today's, images_read's and sheets_read's limits and refusals, and the deprecation of Jelly's old calendar.today.
 */

const CALENDAR = fileURLToPath(new URL("./fixtures/calendar-events.json", import.meta.url))
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0])
const DRIVE_LINK = "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view"

let dir: string
const runtimes: Runtime[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-gws-sources-"))
})

afterEach(async () => {
  for (const name of ["FAKE_GWS_CALENDAR", "FAKE_GWS_RESPONSES", "FAKE_GWS_OUTPUT_FILE", "FAKE_GWS_LOG"]) delete process.env[name]
  for (const runtime of runtimes.splice(0)) await runtime.close()
  rmSync(dir, { recursive: true, force: true })
  resetDeprecated()
})

type Signed = { alias: string; connected: boolean; email?: string; grantedScopes?: string[] }

async function harness(
  services: string[],
  signedIn: Signed[] = [{ alias: "personal", connected: true, email: "sam.rivera@example.com", grantedScopes: [] }],
  options: { config?: Record<string, unknown>; refuse?: string; scopes?: string[]; onAuthState?: RuntimeOptions["onAuthState"] } = {},
) {
  const runtime = await testRuntime({ accounts: { personal: account({ services }) }, ...options.config }, {
    ...(options.scopes ? { tokenProvider: fakeTokens(undefined, options.scopes) } : {}),
    onAuthState: options.onAuthState,
  })
  runtimes.push(runtime)
  const asserted: PermissionRequest[] = []
  const methods = scriptMethods({
    runtime,
    status: (async () => ({ accounts: signedIn })) as never,
    assert: async (request) => {
      asserted.push(request)
      if (request.action === options.refuse) throw new GwsError("PERMISSION_DENIED", "fixture permission refused")
    },
  }) as PluginMethod[]
  const call = (): ToolCall => ({ sessionID: "ses_sources", agent: "build", messageID: "msg_sources", id: "call_sources", signal: new AbortController().signal, progress: async () => {} })
  const run = (name: string, input: unknown) => methods.find((method) => method.name === name)!.run(input, call()) as Promise<Record<string, unknown>>
  return { run, asserted, runtime, methods }
}

describe("probe", () => {
  it("names the owner from the verified sign-in, with only that source's scopes, and asserts gws.probe alone", async () => {
    const { run, asserted } = await harness(["gmail", "calendar"], [
      {
        alias: "personal",
        connected: true,
        email: "sam.rivera@example.com",
        grantedScopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events.readonly"],
      },
    ])
    expect(await run("probe", { source: "calendar" })).toEqual({
      source: "calendar",
      account: "personal",
      owner: { id: "mailto:sam.rivera@example.com", label: "sam.rivera@example.com" },
      scopes: ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events.readonly"],
      trust: "untrusted",
    })
    expect(await run("probe", {})).toMatchObject({ source: "gmail", scopes: ["https://www.googleapis.com/auth/gmail.readonly"] })
    expect(asserted.map((request) => [request.action, request.resources])).toEqual([
      ["gws.probe", ["*"]],
      ["gws.probe", ["*"]],
    ])
  })

  it("refuses an account with no verified email, a source it does not know, any other input, and a service the account does not enable", async () => {
    const { run } = await harness(["gmail"], [{ alias: "personal", connected: true }])
    await expect(run("probe", { source: "gmail" })).rejects.toThrow(/^AUTH_REQUIRED: The account 'personal' has no verified sign-in email/)
    await expect(run("probe", { source: "drive" })).rejects.toThrow(/^SOURCE_UNKNOWN: /)
    await expect(run("probe", { source: "gmail", limit: 0 })).rejects.toThrow(/^INPUT_INVALID: "limit" is not an input of probe/)
    await expect(run("probe", { source: "calendar" })).rejects.toThrow(/^POLICY_DENIED: /)
  })
})

describe("events_list for Calendar", () => {
  it("lists the window, then follows its cursor, with a cancellation as a meeting with the cancelled label, and refuses a cursor of another calendar", async () => {
    const calendar = join(dir, "calendar.json")
    copyFileSync(CALENDAR, calendar)
    process.env["FAKE_GWS_CALENDAR"] = calendar
    const { run, asserted, methods } = await harness(["calendar"])
    const first = await run("events_list", { source: "calendar", since: "2026-11-01T00:00:00Z" })
    expect(first).toMatchObject({ source: "calendar", account: "personal", owner: { id: "mailto:sam.rivera@example.com", label: "Sam Rivera" }, scope: { calendars: ["primary"] }, more: false })
    const events = first["events"] as Array<{ external_id: string; labels: string[]; actors: unknown[] }>
    // A cancellation happens when it was cancelled: evt-b was cancelled before evt-a starts.
    expect(events.map((event) => event.external_id)).toEqual(["evt-b", "evt-a", "evt-c"])
    expect(events[0]).toMatchObject({ labels: ["cancelled"], actors: [] })
    expect(first["refused"]).toEqual([{ external_id: "evt-secret", reason: "secret", detail: "holds a secret (password)" }])
    // The tombstone is a removal, and the registered output model keeps it for the consumer rather than stripping it.
    const removals = first["removals"]
    expect(removals).toEqual([{ external_id: "evt-gone", at: expect.any(String), reason: "deleted" }])
    expect(EventsListOutput.parse(first).removals).toEqual(removals)
    const method = methods.find((candidate) => candidate.name === "events_list")!
    const declared = (
      method.output as {
        properties?: { removals?: { type?: string; items?: { required?: string[]; properties?: { reason?: { enum?: string[] } } } } }
      }
    ).properties?.removals
    expect(declared?.type).toBe("array")
    expect(declared?.items?.required).toEqual(expect.arrayContaining(["external_id", "at", "reason"]))
    expect(Object.keys(declared?.items?.properties ?? {})).toEqual(expect.arrayContaining(["external_id", "at", "reason"]))
    expect(declared?.items?.properties?.reason?.enum).toEqual(expect.arrayContaining(["deleted", "withheld", "expired"]))
    expect(asserted.slice(0, 3).map((request) => [request.action, request.resources])).toEqual([
      ["gws.events_list", ["personal:calendar.events.list"]],
      ["gws.read", ["personal:calendar.calendarList.get"]],
      ["gws.read", ["personal:calendar.events.list"]],
    ])
    const next = await run("events_list", { source: "calendar", cursor: first["cursor"] })
    expect(next).toMatchObject({ events: [], more: false })
    // The same cursor read for the primary calendar named by its id is another binding.
    await expect(run("events_list", { source: "calendar", cursor: first["cursor"], scope: { calendars: ["sam.rivera@example.com"] } })).rejects.toThrow(/^CURSOR_INVALID: /)
  })
})

describe("calendar_today", () => {
  it("answers today's agenda with titles and locations cut to the output's 120 characters", async () => {
    const now = Date.now()
    process.env["FAKE_GWS_RESPONSES"] = JSON.stringify({
      "calendar.calendars.get": { timeZone: "UTC" },
      "calendar.events.list": {
        items: [{ id: "evt-long", status: "confirmed", summary: "T".repeat(180), location: "L".repeat(150), start: { dateTime: new Date(now - 60_000).toISOString() }, end: { dateTime: new Date(now + 60_000).toISOString() } }],
      },
    })
    const { run, asserted } = await harness(["calendar"])
    const answer = await run("calendar_today", { source: "calendar-today" })
    const [item] = (answer["data"] as { items: Array<{ title: string; location: string }> }).items
    expect(item?.title).toHaveLength(120)
    expect(item?.location).toHaveLength(120)
    expect(answer).toMatchObject({ account: "personal", trust: "untrusted" })
    expect(asserted.map((request) => request.action)).toEqual(["gws.calendar_today", "gws.read", "gws.read"])
    await expect(run("calendar_today", { source: "calendar" })).rejects.toThrow(/^INPUT_INVALID: "source" must be "calendar-today"/)
  })
})

describe("images_read", () => {
  it("refuses a GIF, which the image output does not take", async () => {
    const picture = join(dir, "picture.gif")
    writeFileSync(picture, GIF)
    process.env["FAKE_GWS_OUTPUT_FILE"] = picture
    process.env["FAKE_GWS_RESPONSES"] = JSON.stringify({ "drive.files.get": { mimeType: "image/gif", size: String(GIF.length) } })
    const { run } = await harness(["drive"])
    await expect(run("images_read", { url: DRIVE_LINK, account: "personal" })).rejects.toThrow(/^IMAGE_TYPE_REFUSED: /)
  })

  it("answers TOO_LARGE for a picture whose data URI is over the output's limit, rather than cutting it", async () => {
    const big = new Uint8Array(Math.ceil((IMAGE_DATA_URI_MAX * 3) / 4))
    big.set(PNG)
    const picture = join(dir, "picture.png")
    writeFileSync(picture, big)
    process.env["FAKE_GWS_OUTPUT_FILE"] = picture
    process.env["FAKE_GWS_RESPONSES"] = JSON.stringify({ "drive.files.get": { mimeType: "image/png", size: String(big.length) } })
    const { run, asserted } = await harness(["drive"])
    await expect(run("images_read", { url: DRIVE_LINK, account: "personal" })).rejects.toThrow(/^TOO_LARGE: /)
    expect(asserted.map((request) => [request.action, request.resources])).toEqual([
      ["gws.images_read", ["*"]],
      ["gws.read", ["personal:drive.files.get"]],
    ])
  })
})

describe("images_read on Google's image servers", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("fetches with no account's token, even an address Google returned to the account, asserts no gws.read, and names no account", async () => {
    const address = "https://lh3.googleusercontent.com/drive-storage/AJQWtBfake=s220"
    const requests: Array<{ url: string; authorization: string | null }> = []
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      requests.push({ url, authorization: new Headers(init.headers).get("authorization") })
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } })
    })
    const { run, asserted, runtime } = await harness(["drive"])
    runtime.imageSources.record("personal", { thumbnailLink: address })
    const answer = await run("images_read", { url: address, account: "personal" })
    expect(requests).toEqual([{ url: address, authorization: null }])
    expect(answer).toMatchObject({ data: { dataUri: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}` }, trust: "untrusted" })
    expect(answer["account"]).toBeUndefined()
    expect(asserted.map((request) => request.action)).toEqual(["gws.images_read"])
  })
})

describe("sheets_read", () => {
  const SHEET_ID = "synthetic_spreadsheet_fixture"
  const input = { spreadsheetId: SHEET_ID, range: "Sheet1!A1:B2" }
  const answers = (values: unknown) => {
    process.env["FAKE_GWS_RESPONSES"] = JSON.stringify({ [SHEETS_OPERATION]: values })
  }

  it("answers the range Google resolved, the sheet's title and the rows, after asserting gws.sheets_read and gws.read on values.get alone", async () => {
    const log = join(dir, "argv.jsonl")
    process.env["FAKE_GWS_LOG"] = log
    answers({ range: "'It''s Q3!'!A1:C3", majorDimension: "ROWS", values: [["Name", "Amount", "Paid"], ["Ada", "1,200.00", true], ["Grace", 0]] })
    const { run, asserted } = await harness(["sheets"])
    const start = Date.now()
    const range = "'It''s Q3!'!$a$1:$c$3"
    const answer = await run("sheets_read", { ...input, source: "sheets", account: "personal", range })
    expect(answer).toMatchObject({
      data: { range: "'It''s Q3!'!A1:C3", sheet: "It's Q3!", rows: [["Name", "Amount", "Paid"], ["Ada", "1,200.00", true], ["Grace", 0]] },
      account: "personal",
      trust: "untrusted",
    })
    expect(Date.parse(answer["asOf"] as string)).toBeGreaterThanOrEqual(start)
    expect(Date.parse(answer["asOf"] as string)).toBeLessThanOrEqual(Date.now())
    expect(asserted.map((request) => [request.action, request.resources])).toEqual([
      ["gws.sheets_read", ["*"]],
      ["gws.read", [`personal:${SHEETS_OPERATION}`]],
    ])
    expect(asserted.map((request) => request.metadata)).toEqual([{}, { account: "personal", operation: SHEETS_OPERATION, service: "sheets", category: "read" }])
    const ran = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]).filter((argv) => argv[0] !== "--version")
    expect(ran).toHaveLength(1)
    expect(ran[0]!.slice(0, 5)).toEqual(["sheets", "spreadsheets", "values", "get", "--params"])
    expect(JSON.parse(ran[0]![5]!)).toEqual({ spreadsheetId: SHEET_ID, range, majorDimension: "ROWS", valueRenderOption: "FORMATTED_VALUE", fields: "range,majorDimension,values" })
    expect(ran[0]).not.toContain("--page-all")
  })

  it("uses the sole account when none is named, and answers an empty single cell as no rows", async () => {
    answers({ range: "'Sheet1'!A1:A1", majorDimension: "ROWS" })
    const { run } = await harness(["sheets"])
    expect(await run("sheets_read", { ...input, range: "Sheet1!A1" })).toMatchObject({ data: { range: "'Sheet1'!A1:A1", sheet: "Sheet1", rows: [] }, account: "personal" })
  })

  it("refuses a missing or malformed spreadsheet id or range, another source and any other input, before any read", async () => {
    const log = join(dir, "argv.jsonl")
    process.env["FAKE_GWS_LOG"] = log
    const { run, asserted } = await harness(["sheets"])
    await expect(run("sheets_read", { range: input.range })).rejects.toThrow(/^INPUT_INVALID: "spreadsheetId"/)
    await expect(run("sheets_read", { spreadsheetId: SHEET_ID })).rejects.toThrow(/^INPUT_INVALID: "range"/)
    await expect(run("sheets_read", { ...input, spreadsheetId: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit` })).rejects.toThrow(/^INPUT_INVALID: "spreadsheetId"/)
    for (const range of ["Sheet1", "A1:B3", "NamedRange", "Sheet1!A:A", "Sheet1!1:5", "Sheet1!A1:B", "Sheet1!B2:A1", "Sheet1!A1,B2", "Sheet1!A0", "'Q\n3'!A1", `${"x".repeat(257)}!A1`]) {
      await expect(run("sheets_read", { ...input, range })).rejects.toThrow(/^INPUT_INVALID: "range"/)
    }
    await expect(run("sheets_read", { ...input, range: "Sheet1!A1:B50001" })).rejects.toThrow(/at most 100000 cells/)
    await expect(run("sheets_read", { ...input, source: "image" })).rejects.toThrow(/^INPUT_INVALID: "source" must be "sheets"/)
    await expect(run("sheets_read", { ...input, valueRenderOption: "FORMULA" })).rejects.toThrow(/^INPUT_INVALID: "valueRenderOption" is not an input/)
    expect(asserted).toEqual([])
    expect(existsSync(log)).toBe(false)
  })

  it("requires an explicit known account when several exist, and never falls back if that account disables Sheets", async () => {
    const { run, asserted } = await harness(["sheets"], undefined, { config: { accounts: { default: account({ services: ["sheets"] }), other: account({ services: ["drive"] }) } } })
    await expect(run("sheets_read", input)).rejects.toThrow(/^ACCOUNT_REQUIRED: /)
    await expect(run("sheets_read", { ...input, account: "unknown" })).rejects.toThrow(/^ACCOUNT_UNKNOWN: /)
    await expect(run("sheets_read", { ...input, account: "other" })).rejects.toThrow(/^POLICY_DENIED: /)
    expect(asserted).toEqual([])
    answers({ range: input.range, majorDimension: "ROWS" })
    expect(await run("sheets_read", { ...input, account: "default" })).toMatchObject({ account: "default" })
    expect(asserted.at(-1)?.resources).toEqual([`default:${SHEETS_OPERATION}`])
  })

  it("probes only the selected verified principal and allows only scopes accepted by values.get in its probe result", async () => {
    const sheets = "https://www.googleapis.com/auth/spreadsheets.readonly"
    const drive = "https://www.googleapis.com/auth/drive.file"
    const log = join(dir, "argv.jsonl")
    process.env["FAKE_GWS_LOG"] = log
    const { run } = await harness(["sheets"], [
      { alias: "personal", connected: true, email: "owner@example.test", grantedScopes: [sheets, drive, "https://www.googleapis.com/auth/drive.metadata.readonly", "openid"] },
    ])
    expect(await run("probe", { source: "sheets", account: "personal" })).toEqual({
      source: "sheets", account: "personal", owner: { id: "mailto:owner@example.test", label: "owner@example.test" }, scopes: [sheets, drive], trust: "untrusted",
    })
    expect(existsSync(log)).toBe(false)
  })

  it.each(["gws.sheets_read", "gws.read"])("does not run gws when %s is refused", async (refuse) => {
    const log = join(dir, "argv.jsonl")
    process.env["FAKE_GWS_LOG"] = log
    const { run, asserted } = await harness(["sheets"], undefined, { refuse })
    await expect(run("sheets_read", input)).rejects.toThrow(/^PERMISSION_DENIED: /)
    expect(asserted.map(({ action }) => action)).toEqual(refuse === "gws.read" ? ["gws.sheets_read", "gws.read"] : ["gws.sheets_read"])
    expect(existsSync(log)).toBe(false)
  })

  it("passes through the read policy and scope checks", async () => {
    const blocked = await harness(["sheets"], undefined, { config: { policy: { rules: [{ id: "no-reads", effect: "deny", categories: ["read"] }] } } })
    await expect(blocked.run("sheets_read", input)).rejects.toThrow(/^POLICY_DENIED: /)
    const missingScope = await harness(["sheets"], undefined, { scopes: ["https://www.googleapis.com/auth/drive.metadata.readonly"] })
    await expect(missingScope.run("sheets_read", input)).rejects.toThrow(/^AUTH_SCOPE_MISSING: /)
  })

  it.each([
    [400, "INVALID_ARGUMENT", "INPUT_INVALID"],
    [404, "NOT_FOUND", "INPUT_INVALID"],
    [403, "PERMISSION_DENIED", "PERMISSION_DENIED"],
    [429, "RESOURCE_EXHAUSTED", "GWS_API_ERROR"],
    [500, "INTERNAL", "GWS_API_ERROR"],
  ])("maps HTTP %s (%s) to %s without echoing provider text", async (code, status, expected) => {
    const onAuthState = vi.fn()
    const { run } = await harness(["sheets"], undefined, { onAuthState })
    answers({ $error: { code, status, message: "fixture-do-not-echo" } })
    const outcome = await run("sheets_read", input).catch((error: unknown) => GwsError.from(error))
    expect(outcome).toMatchObject({ code: expected })
    expect(outcome).not.toHaveProperty("message", expect.stringContaining("fixture-do-not-echo"))
    expect(onAuthState).not.toHaveBeenCalled()
  })

  it.each([
    ["AUTH_REQUIRED", { code: 401, status: "UNAUTHENTICATED", message: "The access token has expired." }],
    ["AUTH_SCOPE_MISSING", { code: 403, details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }], message: "The token lacks the required scope." }],
    ["AUTH_SCOPE_MISSING", { code: 403, reason: "unknown", message: "Request had insufficient authentication scopes." }],
    ["API_DISABLED", {
      code: 403,
      errors: [{ reason: "accessNotConfigured" }],
      message: "The API is disabled in project fixture-project.",
      enable_url: "https://console.cloud.google.com/apis/library/sheets.googleapis.com?project=fixture-project",
    }],
  ] as const)("keeps typed %s remediation without provider details", async (code, payload) => {
    const onAuthState = vi.fn()
    const { run } = await harness(["sheets"], undefined, { onAuthState })
    answers({ $error: payload })
    const outcome = await run("sheets_read", input).catch((error: unknown) => GwsError.from(error))
    expect(outcome).toBeInstanceOf(GwsError)
    expect(outcome).toMatchObject({ code })
    expect(outcome).not.toHaveProperty("message", expect.stringContaining(payload.message))
    expect(outcome?.enableUrl).toBeUndefined()
    if (code === "API_DISABLED") {
      expect(outcome).toHaveProperty("next", expect.stringContaining("Google Cloud console"))
      expect(JSON.stringify(outcome)).not.toContain("fixture-project")
      expect(onAuthState).not.toHaveBeenCalled()
    } else {
      expect(onAuthState).toHaveBeenCalledExactlyOnceWith("personal", expect.objectContaining({ status: "needs_auth", code }), expect.any(AbortSignal))
    }
  })

  it("does not mark sign-in as healthy when a native error arrives with exit zero", async () => {
    const onAuthState = vi.fn()
    const { run } = await harness(["sheets"], undefined, { onAuthState })
    answers({ error: { code: 403, status: "PERMISSION_DENIED", message: "This account cannot read the spreadsheet." } })
    await expect(run("sheets_read", input)).rejects.toThrow(/^PERMISSION_DENIED: /)
    expect(onAuthState).not.toHaveBeenCalled()
  })

  it.each([
    { range: "Other!A1:B2", majorDimension: "ROWS" },
    { range: "Sheet1!A1:C2", majorDimension: "ROWS" },
    { range: "A1:B2", majorDimension: "ROWS" },
    { majorDimension: "ROWS" },
    { range: input.range, majorDimension: "COLUMNS", values: [["x"]] },
    { range: input.range, majorDimension: "ROWS", values: [["x", "y", "z"]] },
    { range: input.range, majorDimension: "ROWS", values: [[], [], ["z"]] },
    { range: input.range, majorDimension: "ROWS", values: { cells: [] } },
    { range: input.range, majorDimension: "ROWS", values: ["bad row"] },
    { range: input.range, majorDimension: "ROWS", values: [[null]] },
    { range: input.range, majorDimension: "ROWS", values: [[{ value: "bad cell" }]] },
  ])("refuses malformed or mismatched provider metadata and rows (%j)", async (result) => {
    const { run } = await harness(["sheets"])
    answers(result)
    await expect(run("sheets_read", input)).rejects.toThrow(/^GWS_API_ERROR: Google did not return row values and range metadata matching the Sheets request/)
  })

  it("measures the full snapshot in UTF-8 bytes and refuses the first byte over maxBytes", async () => {
    const big = join(dir, "values.json")
    answers({ $file: big })
    const { run } = await harness(["sheets"])
    const values = [[""]]
    const empty = { data: { range: input.range, sheet: "Sheet1", rows: values }, asOf: "2000-01-01T00:00:00.000Z", account: "personal", trust: "untrusted" }
    const room = SHEETS_MAX_BYTES - Buffer.byteLength(JSON.stringify(empty))
    const payload = "界".repeat(Math.floor(room / 3)) + "x".repeat(room % 3)
    const write = (text: string) => {
      const provider = JSON.stringify({ range: input.range, majorDimension: "ROWS", values: [[text]] })
      expect(Buffer.byteLength(provider)).toBeLessThan(SHEETS_MAX_BYTES)
      writeFileSync(big, provider)
    }
    write(payload)
    expect(Buffer.byteLength(JSON.stringify(await run("sheets_read", input)))).toBe(SHEETS_MAX_BYTES)
    write(`${payload}x`)
    await expect(run("sheets_read", input)).rejects.toThrow(/^TOO_LARGE: .*Next step: Read a smaller range\./)
  })

  it("does not accept partial JSON after the process output cap is hit", async () => {
    const { run } = await harness(["sheets"], undefined, { config: { execution: { maxStdoutBytes: 256 } } })
    answers({ range: input.range, majorDimension: "ROWS", values: [["x".repeat(512)]] })
    await expect(run("sheets_read", input)).rejects.toThrow(/^OUTPUT_LIMIT: .*Next step: Read a smaller range\./)
  })

  it("refuses capped process output even when the process reports success and the retained body is valid", async () => {
    const { run, runtime } = await harness(["sheets"])
    const mock = vi.spyOn(Accounts.prototype, "run").mockResolvedValue({
      stdout: Buffer.from(JSON.stringify({ range: input.range, majorDimension: "ROWS", values: [["sample"]] })),
      stderr: Buffer.alloc(0),
      exitCode: 0, signal: null, durationMs: 1, timedOut: false, outputCapped: true,
    })
    try {
      await expect(run("sheets_read", input)).rejects.toThrow(/^OUTPUT_LIMIT: /)
      await expect(runtime.read({ operation: SHEETS_OPERATION, params: input, fields: "range,majorDimension,values" }, { sessionId: "ses_sources", agentId: "build" })).rejects.toThrow(/^OUTPUT_LIMIT: /)
    } finally {
      mock.mockRestore()
    }
  })
})

describe("Jelly's calendar.today", () => {
  it("is named in status once it is called, with the method to use instead", () => {
    expect(deprecatedNote()).toBeUndefined()
    markCalendarTodayCalled()
    expect(deprecatedNote()).toBe(
      "Deprecated method called: calendar.today on @joe-broadhead/opencode-gws. Use calendar_today on google-workspace.gws.tools instead; the old method works until 0.1.0.",
    )
  })
})
