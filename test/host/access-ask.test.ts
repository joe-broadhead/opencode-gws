import { afterAll, describe, expect, it } from "vitest"
import { accessHost, expectAccessBlock, writeRule } from "./access.js"

let run: Awaited<ReturnType<typeof accessHost>>

afterAll(async () => {
  await run?.close()
})

describe("access: ask-changes", () => {
  it("asks for every non-read, accepts a saved allow, and keeps rule order", async () => {
    run = await accessHost("ask-changes")
    expect(run.refusal).toBeUndefined()
    expect(run.failure).toBeUndefined()
    expectAccessBlock(run, "ask-changes")

    const readSession = await run.session([])
    expect(await run.assert({ sessionID: readSession, action: "gws.read", resources: ["work:*"] })).toEqual({ ok: true })

    // A saved "Always allow" is a session allow rule; it answers the generated ask without a new prompt.
    const saved = await run.session([writeRule("allow")])
    expect(await run.assert({ sessionID: saved, action: "gws.write", resources: ["work:*"] })).toEqual({ ok: true })

    // A later matching rule wins: deny then allow permits, allow then deny refuses.
    const denyThenAllow = await run.session([writeRule("deny"), writeRule("allow")])
    expect(await run.assert({ sessionID: denyThenAllow, action: "gws.write", resources: ["work:*"] })).toEqual({ ok: true })
    const allowThenDeny = await run.session([writeRule("allow"), writeRule("deny")])
    expect(await run.assert({ sessionID: allowThenDeny, action: "gws.write", resources: ["work:*"] })).toMatchObject({
      ok: false,
      code: "PERMISSION_DENIED",
    })
  })
})
