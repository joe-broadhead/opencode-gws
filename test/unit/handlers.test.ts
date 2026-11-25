import { describe, expect, it, vi } from "vitest"
import type { MethodCall } from "@we-the-rebel-alliance/plugin-contract/register"
import { createHandlers } from "../../src/handlers/index.js"
import { manifest } from "../../src/manifest.js"
import type { RuntimeStatus } from "../../src/provider/domain/status.js"

const status: RuntimeStatus = {
  auditDegraded: false,
  version: "0.0.0",
  binary: { path: "/cache/gws", version: "gws 0.22.5" },
  services: ["gmail"],
  accounts: [
    { alias: "work", mode: "interactive", services: ["gmail"], connected: true, email: "ana@example.test", grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"] },
    { alias: "personal", mode: "interactive", services: ["drive"], connected: false, needsAuth: true, nextStep: "Sign in again." },
  ],
}

const call = (overrides: Partial<MethodCall> = {}): MethodCall =>
  ({
    sessionID: "session",
    agent: "build",
    messageID: "message",
    id: "call",
    signal: new AbortController().signal,
    progress: async () => undefined,
    account: "work",
    door: "tool",
    bus: { name: "gws", emit: async () => ({ ok: true }) as const },
    unguardedAgents: async () => ({ ok: true, agents: [] }) as const,
    ...overrides,
  }) as MethodCall

const handlers = (runtime: Record<string, unknown>, state = { hostVersion: "2.4.1", accountProblems: [] as string[] }) =>
  createHandlers({ runtime: runtime as never, manifest, version: "0.0.0", state })

describe("handler table", () => {
  it("has exactly the manifest's methods", () => {
    expect(Object.keys(handlers({})).sort()).toEqual(Object.keys(manifest.methods).sort())
  })
})

describe("status", () => {
  it("answers the contract's shape, one entry per alias, with the agents that lack the rules", async () => {
    const table = handlers({ status: async () => status })
    const answer = (await table.status.run({}, call({ unguardedAgents: async () => ({ ok: true, agents: ["build"] }) as const }))) as Record<string, unknown>
    expect(answer).toMatchObject({ name: "gws", version: "0.0.0", state: "needs_sign_in", unguardedAgents: ["build"] })
    expect(answer["accounts"]).toEqual([
      { alias: "work", state: "ready", owner: { id: "mailto:ana@example.test", label: "ana@example.test" } },
      { alias: "personal", state: "needs_sign_in", reason: "Sign in again." },
    ])
  })

  it("reports a registration problem as an error with its next step", async () => {
    const table = handlers({ status: async () => status }, { hostVersion: "2.4.1", accountProblems: ["accounts.work: the integration could not be registered"] })
    const answer = (await table.status.run({}, call())) as Record<string, unknown>
    expect(answer).toMatchObject({ state: "error", nextStep: "accounts.work: the integration could not be registered" })
  })
})

describe("probe", () => {
  it("names the owner and the source's scopes, and reads no content", async () => {
    const table = handlers({ status: async () => status })
    const answer = (await table.probe.run({ source: "gmail" }, call())) as Record<string, unknown>
    expect(answer).toMatchObject({ source: "gmail", account: "work", owner: { id: "mailto:ana@example.test", label: "ana@example.test" }, trust: "untrusted" })
    expect(answer["scopes"]).toEqual(["https://www.googleapis.com/auth/gmail.readonly"])
  })

  it("refuses an unknown source and an account with no verified sign-in", async () => {
    const table = handlers({ status: async () => status })
    await expect(table.probe.run({ source: "nope" }, call())).rejects.toThrow(/^SOURCE_UNKNOWN: /)
    await expect(table.probe.run({ source: "sheets" }, call())).rejects.toThrow(/^SOURCE_UNKNOWN: /)
    await expect(table.probe.run({ source: "gmail" }, call({ account: "personal" }))).rejects.toThrow(/^NEEDS_SIGN_IN: /)
  })
})

describe("plan and commit", () => {
  const plan = {
    planId: "gws-plan-1",
    expiresAt: "2026-11-20T09:15:00.000Z",
    category: "send",
    preview: { method: "gmail +send", params: { to: ["sam@example.test"] }, recipients: ["sam@example.test"], account: "work", category: "send" },
    dryRun: { ok: true },
  }
  const runtime = {
    inspect: () => ({ account: "work", operation: "gmail.send", service: "gmail", category: "send" }),
    plan: async () => plan,
    commit: async () => ({ ok: true, planId: plan.planId, category: "send", operation: "gmail.send", result: { id: "m1" } }),
  }

  it("refuses an operation whose effective category is another plan's class", async () => {
    const table = handlers(runtime)
    await expect(table.plan_write.run({ operation: "gmail.send" }, call())).rejects.toThrow(/^PLAN_INVALID: plan_write: plan_write plans only write operations/)
  })

  it("plans with the committing method and a preview, and keeps the gws plan id private", async () => {
    const table = handlers(runtime)
    const answer = (await table.plan_send.run({ operation: "gmail.send", input: { to: "sam@example.test", subject: "s", body: "b" } }, call())) as Record<string, unknown>
    expect(answer).toMatchObject({ method: "send", trust: "untrusted", gwsPlanId: "gws-plan-1" })
    expect(answer["reaches"]).toEqual([{ id: "sam@example.test" }])
    expect(JSON.stringify(answer)).not.toContain("planId")
  })

  it("commits the plan and nudges the Gmail source it changes", async () => {
    const emit = vi.fn(async () => ({ ok: true }) as const)
    const table = handlers(runtime)
    const answer = (await table.send.run({}, call({ plan: { gwsPlanId: "gws-plan-1" }, bus: { name: "gws", emit } }))) as Record<string, unknown>
    expect(answer).toEqual({ ok: true, category: "send", operation: "gmail.send", result: { id: "m1" }, trust: "untrusted" })
    expect(emit).toHaveBeenCalledExactlyOnceWith("changed", { capability: "gws.gmail", account: "work", reason: "write" })
  })

  it("emits no nudge when no declared source changes", async () => {
    const emit = vi.fn(async () => ({ ok: true }) as const)
    const table = handlers({ ...runtime, commit: async () => ({ ok: true, planId: "p", category: "write", operation: "drive.files.update", result: {} }) })
    await table.write.run({}, call({ plan: { gwsPlanId: "p" }, bus: { name: "gws", emit } }))
    expect(emit).not.toHaveBeenCalled()
  })

  it("does not nudge a declared source for a Gmail or Calendar settings write", async () => {
    const emit = vi.fn(async () => ({ ok: true }) as const)
    const table = handlers({ ...runtime, commit: async () => ({ ok: true, planId: "p", category: "write", operation: "gmail.users.settings.updateVacation", result: {} }) })
    await table.write.run({}, call({ plan: { gwsPlanId: "p" }, bus: { name: "gws", emit } }))
    expect(emit).not.toHaveBeenCalled()
    const calendar = handlers({ ...runtime, commit: async () => ({ ok: true, planId: "p", category: "write", operation: "calendar.settings.watch", result: {} }) })
    await calendar.write.run({}, call({ plan: { gwsPlanId: "p" }, bus: { name: "gws", emit } }))
    expect(emit).not.toHaveBeenCalled()
  })

  it("emits no nudge for an export of a declared source", async () => {
    const emit = vi.fn(async () => ({ ok: true }) as const)
    const table = handlers({ ...runtime, commit: async () => ({ ok: true, planId: "p", category: "export", operation: "calendar.events.list", result: {} }) })
    await table.export.run({}, call({ plan: { gwsPlanId: "p" }, bus: { name: "gws", emit } }))
    expect(emit).not.toHaveBeenCalled()
  })

  it("refuses a plan whose private id is missing", async () => {
    const table = handlers(runtime)
    await expect(table.send.run({}, call({ plan: {} }))).rejects.toThrow(/^PLAN_INVALID: /)
  })
})
