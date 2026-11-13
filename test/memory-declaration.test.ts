import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"
import { CALENDAR_FOLLOW, CALENDAR_READS, CALENDAR_SETUP, CALENDAR_SOURCE } from "../src/host/calendar-events.js"
import { GMAIL_READS, GMAIL_SETUP, GMAIL_SOURCE } from "../src/host/gmail-events.js"

/**
 * `package.json#memory`, checked two ways: Memory's vendored kit (`test/support/memory-kit.mjs`, the published copy),
 * and the truth of what the code asserts. The grants are derived from the reads each `events_list` call makes, and the
 * identity grants from what `limit: 0` asserts, so a change to the tool that the manifest does not follow fails here
 * before Memory's recording-context conformance does.
 */

const require = createRequire(import.meta.url)
const kit = require("./support/memory-kit.mjs") as {
  memoryDeclarationProblems(memory: unknown): string[]
  assertMemoryDeclaration(memory: unknown): void
  sizeOf(memory: unknown): number
  SIZE_WARN_BYTES: number
}

interface Grant {
  action: string
  resource: string
}

interface Block {
  method: string
  input?: Record<string, unknown>
  grants: Grant[]
  scopeInputs?: Record<string, string>
}

const read = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"))
const pkg = read("package.json") as { memory: Memory }
const memory = pkg.memory

interface Memory {
  version: number
  namespace: string
  connector: {
    operationScoped?: boolean
    reads: Block[]
    scope: Array<{ key: string }>
    identityRead?: Block
  }
  sources: Array<{
    id: string
    contract: number
    kinds: string[]
    grants: Grant[]
    scope: Array<{ key: string }>
    identity?: Block
    setupHint?: string
  }>
  templates: Array<{
    id: string
    extract: { steps: Array<Record<string, unknown>> }
    curate: { stages: Array<Record<string, unknown>> }
    outputs: string[]
  }>
}

const source = (id: string) => memory.sources.find((candidate) => candidate.id === id)!
const grant = (action: string, resource: string): Grant => ({ action, resource })

/** Exactly what a source's `events_list` asserts: its method on `*`, then one read per operation it may run. */
const eventsGrants = (reads: readonly string[]): Grant[] => [grant("gws.events_list", "*"), ...reads.map((operation) => grant("gws.read", `{account}:${operation}`))]

/** What a source's owner-only call (`limit: 0`) asserts: the method on `*`, then only the identity read. */
const identityGrants = (read: string): Grant[] => [grant("gws.events_list", "*"), grant("gws.read", `{account}:${read}`)]

describe("the memory declaration", () => {
  it("passes Memory's kit, and stays inside the size goal", () => {
    expect(kit.memoryDeclarationProblems(memory)).toEqual([])
    expect(kit.sizeOf(memory)).toBeLessThanOrEqual(kit.SIZE_WARN_BYTES)
  })

  it("is schema v2 in the plugin's namespace, operation-scoped, with both sources the code serves", () => {
    expect(memory.version).toBe(2)
    expect(memory.namespace).toBe("gws")
    expect(memory.connector.operationScoped).toBe(true)
    expect(memory.sources.map((entry) => entry.id)).toEqual([GMAIL_SOURCE, CALENDAR_SOURCE])
    expect(memory.sources.map((entry) => entry.contract)).toEqual([2, 2])
  })

  it("declares the Gmail source's grants as exactly the reads its events_list asserts", () => {
    const gmail = source(GMAIL_SOURCE)
    expect(gmail.grants).toEqual(eventsGrants(GMAIL_READS))
    expect(gmail.scope).toEqual([])
    expect(gmail.setupHint).toBe(GMAIL_SETUP)
  })

  it("declares Gmail's identity grants as exactly what limit 0 asserts: events_list and getProfile only", () => {
    expect(source(GMAIL_SOURCE).identity).toMatchObject({ method: "events_list", input: { source: GMAIL_SOURCE, limit: 0 }, grants: identityGrants(GMAIL_READS[0]), account: "$.owner.id" })
  })

  it("declares the Calendar source's grants as exactly the reads its events_list asserts", () => {
    const calendar = source(CALENDAR_SOURCE)
    expect(calendar.grants).toEqual(eventsGrants(CALENDAR_READS))
    expect(calendar.scope.map((entry) => entry.key)).toEqual(["calendars"])
    expect(calendar.setupHint).toBe(CALENDAR_SETUP)
  })

  it("declares Calendar's identity grants as exactly what limit 0 asserts: events_list and calendarList.get only", () => {
    expect(source(CALENDAR_SOURCE).identity).toMatchObject({ method: "events_list", input: { source: CALENDAR_SOURCE, limit: 0 }, grants: identityGrants(CALENDAR_READS[0]), account: "$.account" })
  })

  it("declares the direct read now that the RPC resolves its resource, with its exact grant and scope input", () => {
    expect(memory.connector.reads).toEqual([
      {
        method: "read",
        input: { operation: CALENDAR_FOLLOW },
        grants: [grant("gws.read", `{account}:${CALENDAR_FOLLOW}`)],
        scopeInputs: { calendarId: "calendars" },
        kinds: ["meeting", "event"],
        cursor: "syncToken",
        billing: null,
      },
    ])
    expect(memory.connector.scope.map((entry) => entry.key)).toEqual(["calendars"])
  })

  it("declares no suggestBy: suggestions are not offered until a bind-time probe read is scoped", () => {
    expect(JSON.stringify(memory)).not.toContain("suggestBy")
    expect(JSON.stringify(memory)).not.toContain('"suggest":true')
  })

  it("names no write verb anywhere in an action, operation, or method", () => {
    const text = JSON.stringify(memory)
    expect(text).not.toMatch(/"[a-z]*\.(send|write|delete|update|create|share|admin)"/)
    for (const block of [memory.connector.identityRead, ...memory.connector.reads, ...memory.sources.flatMap((entry) => entry.identity)]) {
      if (block === undefined) continue
      expect(kit.memoryDeclarationProblems(memory)).toEqual([])
      expect(block.method).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it("carries each template's connector on its steps, no template-level source, and outputs that cover its stages", () => {
    expect(memory.templates.map((template) => template.id)).toEqual(["gmail-commitments", "calendar-meetings"])
    for (const template of memory.templates) {
      expect(template).not.toHaveProperty("source")
      for (const step of template.extract.steps) {
        expect(Object.keys(step).sort()).toEqual(["connector", "source", "use"])
        expect(step["use"]).toBe("events_list")
        expect(step["connector"]).toBe("google-workspace.gws")
        expect([GMAIL_SOURCE, CALENDAR_SOURCE]).toContain(step["source"])
      }
      const written = template.curate.stages.flatMap((stage) => {
        if (stage["engine"] === "render") return [stage["into"]]
        if (stage["engine"] === "extract") return stage["outputs"] as string[]
        return [stage["into"]]
      })
      for (const output of written) expect(template.outputs, `${template.id} writes ${String(output)}`).toContain(output)
    }
  })
})
