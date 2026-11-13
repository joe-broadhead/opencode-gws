import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import type { PermissionRequest } from "../src/host/permissions.js"
import { registerToolsRpc, scriptMethods } from "../src/host/tools-rpc.js"
import type { Runtime } from "../src/runtime/index.js"
import { account, testRuntime } from "./support/config.js"

/**
 * The RPC's per-operation rule (§9.1 B): a plugin-owned method whose action takes a resource resolves it before
 * dispatch, with the direct tool path's account defaulting, and evaluates the session's rules on it. The three cases
 * §9.1 B.5 requires are denied here, and the named operation on the named account is the one that runs.
 */

type Effect = "allow" | "deny" | "ask"
type Rule = { action: string; resource: string; effect: Effect }

const rule = (action: string, resource: string, effect: Effect): Rule => ({ action, resource, effect })
const LOCATION = join(tmpdir(), "gws-operation-scope")

/** The agent's rules: everything allowed, `gws.read` denied on every resource, then one operation on one account allowed. */
const rules = (): Rule[] => [
  rule("*", "*", "allow"),
  rule("gws.read", "*", "deny"),
  rule("gws.read", "one:gmail.users.getProfile", "allow"),
]

const runtimes: Runtime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
})

async function harness() {
  const runtime = await testRuntime({ accounts: { one: account(), two: account() } })
  runtimes.push(runtime)
  const asserted: PermissionRequest[] = []
  const assert = async (request: PermissionRequest) => {
    asserted.push(request)
    throw new Error("assert reached: the call dispatched")
  }
  const methods = scriptMethods({ runtime, assert, status: async () => ({}) as never })
  const handlers: Record<string, (input: unknown, context: { signal: AbortSignal; error: (type: string, message: string, data?: unknown) => unknown }) => Promise<unknown>> = {}
  const ctx = {
    location: { directory: LOCATION },
    rpc: {
      register: async (_definition: unknown, registered: typeof handlers) => {
        Object.assign(handlers, registered)
        return { dispose: async () => {}, events: { emit: async () => {} } }
      },
    },
    permission: { hook: async () => ({ dispose: async () => {} }), assert },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (sessionID !== "ses_1") throw Object.assign(new Error("not found"), { _tag: "Session.NotFoundError" })
        return { id: sessionID, location: { directory: LOCATION }, agent: "build" }
      },
    },
    agent: {
      get: async ({ agentID, location }: { agentID: string; location: unknown }) => {
        if (agentID !== "build") throw Object.assign(new Error("not found"), { _tag: "Agent.NotFoundError" })
        return { location, data: { id: agentID, permissions: rules() } }
      },
    },
    tool: { list: async () => [] },
  }
  await registerToolsRpc(ctx as never, { methods })
  const call = (input: Record<string, unknown>) => handlers["read"]!({ sessionID: "ses_1", input }, { signal: new AbortController().signal, error: (type, message, data) => ({ type, message, data }) })
  return { asserted, call }
}

const refusal = (value: unknown) => expect(structuredClone(value)).toMatchObject({ type: "failed", data: { code: expect.any(String), next: expect.stringMatching(/\.$/) } })
const message = (value: unknown) => (value as { message: string }).message

describe("the tools RPC's per-operation resolve", () => {
  it("runs the named operation on the named account", async () => {
    const { asserted, call } = await harness()
    await expect(call({ account: "one", operation: "gmail.users.getProfile", fields: "emailAddress" })).rejects.toThrow("assert reached: the call dispatched")
    // The spec's own assert names the same resource the pre-dispatch resolved.
    expect(asserted.map((request) => [request.action, request.resources])).toEqual([["gws.read", ["one:gmail.users.getProfile"]]])
  })

  it("denies another operation, naming it", async () => {
    const { asserted, call } = await harness()
    const answer = await call({ account: "one", operation: "gmail.users.history.list", fields: "historyId" })
    refusal(answer)
    expect(message(answer)).toMatch(/gws\.read on one:gmail\.users\.history\.list/)
    expect(asserted).toEqual([])
  })

  it("denies the allowed operation on another account, naming it", async () => {
    const { asserted, call } = await harness()
    const answer = await call({ account: "two", operation: "gmail.users.getProfile", fields: "emailAddress" })
    refusal(answer)
    expect(message(answer)).toMatch(/gws\.read on two:gmail\.users\.getProfile/)
    expect(asserted).toEqual([])
  })

  it("denies a call that names no account when two are configured", async () => {
    const { asserted, call } = await harness()
    const answer = await call({ operation: "gmail.users.getProfile", fields: "emailAddress" })
    refusal(answer)
    expect((answer as { data: { code: string } }).data.code).toBe("ACCOUNT_REQUIRED")
    expect(asserted).toEqual([])
  })
})
