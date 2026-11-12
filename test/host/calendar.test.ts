import { Rpc } from "@opencode/plugin/rpc"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { account } from "../support/config.js"
import { ACCOUNT, type Harness, startHost } from "./harness.js"
import { packageJson } from "./package.js"

/**
 * calendar.today on a real host: registered under the package's own name, the RPC id Jelly calls a view's methods
 * on, answering `{}` from a fake Calendar. The fake gws answers the same events whatever the window, so events are
 * placed around the real clock.
 */

/** The caller's side of the contract, under the id Jelly uses: the package name. The plugin checks both schemas. */
const open = {}
const CalendarRpc = Rpc.define({
  id: packageJson.name as string,
  methods: { "calendar.today": { input: open, output: open, errors: { failed: open } } },
  events: {},
})
const hour = 3_600_000
const at = (host: Harness) => ({ location: host.location })
const today = (host: Harness) => (host.opencode.rpc(CalendarRpc) as unknown as Record<string, (input: unknown, options: unknown) => Promise<unknown>>)["calendar.today"]!

/** The answer, or the declared error's `{ type, code, message }`. */
async function call(host: Harness): Promise<Record<string, any>> {
  try {
    return { value: await today(host)({}, at(host)) }
  } catch (error) {
    const e = error as Record<string, any>
    return { type: e.type ?? e._tag, code: e.data?.code, message: String(e.message ?? e) }
  }
}

afterEach(() => {
  delete process.env["FAKE_GWS_RESPONSES"]
})

describe("calendar.today with a signed-in account", () => {
  let host: Harness
  beforeAll(async () => {
    host = await startHost({ options: { accounts: { [ACCOUNT]: account({ services: ["gmail", "calendar"] }) } } })
  })
  afterAll(async () => {
    await host?.close()
  })

  it("answers today's events from the plugin's own read path, in Jelly's shape", async () => {
    const now = Date.now()
    const iso = (offset: number) => new Date(now + offset).toISOString()
    process.env["FAKE_GWS_RESPONSES"] = JSON.stringify({
      "calendar.calendars.get": { timeZone: "UTC" },
      "calendar.events.list": {
        items: [
          { id: "ongoing", summary: "Ongoing", start: { dateTime: iso(-60_000) }, end: { dateTime: iso(60_000) }, hangoutLink: "https://meet.google.com/abc", description: "never sent" },
          { id: "ended", summary: "Ended", start: { dateTime: iso(-2 * hour) }, end: { dateTime: iso(-hour) } },
          { id: "next-week", summary: "Later", start: { dateTime: iso(7 * 24 * hour) }, end: { dateTime: iso(7 * 24 * hour + hour) } },
        ],
      },
    })
    const result = await call(host)
    expect(result.value).toMatchObject({ account: ACCOUNT, state: "ready", events: [{ id: "ongoing", title: "Ongoing", joinUrl: "https://meet.google.com/abc" }] })
    expect(result.value.events).toHaveLength(1)
    expect(Date.parse(result.value.at)).toBeGreaterThan(now - 5_000)
    expect(JSON.stringify(result.value)).not.toContain("never sent")
    expect(host.invocations().map((argv) => argv.slice(0, 3).join("."))).toEqual(["calendar.calendars.get", "calendar.events.list"])
  })

  it("rejects input other than {}", async () => {
    await expect(today(host)({ account: ACCOUNT }, at(host))).rejects.toBeDefined()
  })
})
