import { Rpc } from "@opencode/plugin/rpc"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { request } from "../support/requests.js"
import { startHost, type Harness } from "./harness.js"

/**
 * `rpcCommits: true` with `access: "ask-changes"`: the commit methods exist, but their action asks, so the RPC
 * refuses each one before dispatch, with no gws call and no prompt left waiting. Its own file, because one embedded
 * host per process is all the SDK supports.
 */

const open = {}
const Tools = Rpc.define({
  id: "google-workspace.gws.tools",
  methods: {
    describe: { input: open, output: open },
    ...Object.fromEntries(["plan", "write", "send", "share", "delete", "export", "admin"].map((name) => [name, { input: open, output: open, errors: { failed: open } }])),
  },
  events: {},
})

let host: Harness
let sessionID: string
let trusted: string

beforeAll(async () => {
  host = await startHost({ options: { rpcCommits: true, access: "ask-changes" } })
  sessionID = (await host.opencode.sessions.create({ location: host.location, agent: "build" } as never)).id
  // An explicit allow on the action, for every resource, is what lets a script commit at ask-changes. Session rules
  // come after the agent's, so this session of the guarded build agent may send, and nothing else changes.
  trusted = (
    await host.opencode.sessions.create({ location: host.location, agent: "build", permissions: [{ action: "gws.send", resource: "*", effect: "allow" }] } as never)
  ).id
}, 120_000)

afterAll(async () => {
  await host?.close()
})

async function run(method: string, input: unknown, session = sessionID): Promise<Record<string, any>> {
  const tools = host.opencode.rpc(Tools) as unknown as Record<string, (input: unknown, options: unknown) => Promise<unknown>>
  try {
    return { value: await tools[method]!({ sessionID: session, input }, { location: host.location }) }
  } catch (error) {
    const e = error as Record<string, any>
    return { type: e.type ?? e._tag, code: e.data?.code, message: String(e.message ?? e) }
  }
}

describe("rpcCommits: true, access: ask-changes", () => {
  it("reports each commit method's permission as ask", async () => {
    const described = (await host.opencode.rpc(Tools).describe({ sessionID }, { location: host.location })) as { methods: Array<{ name: string; permission: string }> }
    const permissions = Object.fromEntries(described.methods.map((method) => [method.name, method.permission]))
    for (const name of ["write", "send", "share", "delete", "export", "admin"]) expect(permissions[name], name).toBe("ask")
    expect(permissions.plan).toBe("allow")
  })

  it("refuses a commit with PERMISSION_DENIED at once: no gws call and no prompt", async () => {
    const planned = await run("plan", request("gmail.reply", { input: { messageId: "m-1", body: "hi" } }))
    expect(planned.value, planned.message).toMatchObject({ ok: true, category: "send", planId: expect.any(String) })
    const before = host.invocations().filter((argv) => !argv.includes("--dry-run")).length
    const prompts = host.events.filter((event) => event.type === "permission.asked").length
    const started = Date.now()
    const refused = await run("send", { planId: planned.value.planId })
    expect(refused).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
    expect(refused.message).toContain("would ask")
    expect(Date.now() - started).toBeLessThan(5000)
    expect(host.invocations().filter((argv) => !argv.includes("--dry-run")).length).toBe(before)
    expect(host.events.filter((event) => event.type === "permission.asked").length).toBe(prompts)
  })

  it("commits when the session's own rule allows the action: the explicit allow decides, and plan-then-commit still holds", async () => {
    const changes = () => host.invocations().filter((argv) => !argv.includes("--dry-run") && !argv.includes("get") && !argv.includes("getProfile")).length
    const before = changes()
    expect(await run("send", { planId: "plan_made_up_0000000000000000" }, trusted)).toMatchObject({ type: "failed", code: "PLAN_NOT_FOUND" })
    const planned = await run("plan", request("gmail.reply", { input: { messageId: "m-1", body: "hi" } }), trusted)
    expect(planned.value, planned.message).toMatchObject({ ok: true, category: "send" })
    const committed = await run("send", { planId: planned.value.planId }, trusted)
    expect(committed.value, committed.message).toMatchObject({ ok: true, category: "send" })
    expect(changes()).toBe(before + 1)
    // The allow covers only gws.send: the session's other commits still ask, so they are refused.
    expect(await run("write", { planId: "plan_made_up_0000000000000000" }, trusted)).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
  })

  it("refuses every commit method with PERMISSION_DENIED, whatever the planId", async () => {
    const before = host.invocations().filter((argv) => !argv.includes("--dry-run")).length
    for (const method of ["write", "send", "share", "delete", "export", "admin"]) {
      expect(await run(method, { planId: "plan_made_up_0000000000000000" }), method).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
    }
    expect(host.invocations().filter((argv) => !argv.includes("--dry-run")).length).toBe(before)
  })
})
