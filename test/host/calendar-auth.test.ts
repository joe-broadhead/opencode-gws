import { Rpc } from "@opencode/plugin/rpc"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { account } from "../support/config.js"
import { type Harness, startHost } from "./harness.js"
import { packageJson } from "./package.js"

/** calendar.today on a real host when the answering account has no sign-in: a coded error, never an empty day. */

const open = {}
const CalendarRpc = Rpc.define({
  id: packageJson.name as string,
  methods: { "calendar.today": { input: open, output: open, errors: { failed: open } } },
  events: {},
})

let host: Harness

async function call(): Promise<Record<string, any>> {
  try {
    return { value: await (host.opencode.rpc(CalendarRpc) as unknown as Record<string, (input: unknown, options: unknown) => Promise<unknown>>)["calendar.today"]!({}, { location: host.location }) }
  } catch (error) {
    const e = error as Record<string, any>
    return { type: e.type ?? e._tag, code: e.data?.code, message: String(e.message ?? e) }
  }
}

describe("calendar.today with an account that is not signed in", () => {
  beforeAll(async () => {
    // The harness signs in only its own account; this one has no sign-in.
    host = await startHost({ options: { accounts: { work: account({ services: ["calendar"] }) } } })
  })
  afterAll(async () => {
    await host?.close()
  })

  it("fails with AUTH_REQUIRED and its next step, and runs no gws call", async () => {
    expect(await call()).toMatchObject({ type: "failed", code: "AUTH_REQUIRED", message: expect.stringMatching(/^AUTH_REQUIRED: .*Next step: /) })
    expect(host.invocations()).toEqual([])
  })
})
