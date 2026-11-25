import { afterAll, describe, expect, it } from "vitest"
import { accessHost, expectAccessBlock } from "./access.js"

let run: Awaited<ReturnType<typeof accessHost>>

afterAll(async () => {
  await run?.close()
})

describe("access: all", () => {
  it("allows the base block, reads and writes on the real 2.4.1 host", async () => {
    run = await accessHost("all")
    expect(run.refusal).toBeUndefined()
    expect(run.failure).toBeUndefined()
    expectAccessBlock(run, "all")
    const sessionID = await run.session([])
    expect(await run.assert({ sessionID, action: "gws.read", resources: ["work:*"] })).toEqual({ ok: true })
    expect(await run.assert({ sessionID, action: "gws.write", resources: ["work:*"] })).toEqual({ ok: true })
  })
})
