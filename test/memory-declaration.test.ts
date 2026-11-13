import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CALENDAR_FOLLOW, CALENDAR_READS, CALENDAR_SETUP, CALENDAR_SOURCE } from "../src/host/calendar-events.js"
import { GMAIL_FOLLOW, GMAIL_READS, GMAIL_SETUP, GMAIL_SOURCE } from "../src/host/gmail-events.js"

/**
 * `package.json#memory`, checked against the code it declares: the sources
 * `events_list` serves, the exact grants each one asserts, contract 2, the
 * setup lines, and Memory's read-verb allowlist with no write verb anywhere in
 * a name. Memory reads this declaration from the installed package, so a
 * grant that drifts from the assert is an outage, and a wider grant is worse.
 */

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  memory: {
    version: number
    namespace: string
    connector: {
      identity: { method: string; input: Record<string, unknown>; grants: Grant[] }
      reads: Array<{ method: string; input: Record<string, unknown>; grants: Grant[] }>
      scope: Array<{ key: string }>
    }
    sources: Array<{
      id: string
      contract: number
      kinds: string[]
      grants: Grant[]
      scope: Array<{ key: string }>
      setup: string
    }>
    templates: Array<{ id: string; extract: { steps: Array<Record<string, unknown>> } }>
  }
}

interface Grant {
  action: string
  resource: string
}

const memory = pkg.memory
const source = (id: string) => memory.sources.find((candidate) => candidate.id === id)!
const grant = (action: string, resource: string): Grant => ({ action, resource })
const READS = ["read", "get", "list", "search", "lookup", "view", "describe", "history", "query", "count", "fetch"]
const WRITES = ["send", "post", "reply", "set", "add", "edit", "create", "update", "upsert", "delete", "remove", "trash", "modify", "patch", "insert", "import", "export", "write", "put", "save", "publish", "share", "invite", "upload", "schedule", "react", "mark", "label", "pin", "follow", "archive", "move", "merge", "close", "comment", "assign", "draft", "approve", "submit", "cancel", "revoke", "grant", "run", "execute", "invoke", "purge", "destroy", "drop", "wipe", "erase", "transfer", "trigger", "kick"]

/** The exact grants `events_list` asserts for a source: the method on `*`, then one read per operation. */
const grantsOf = (follow: string, reads: readonly string[]): Grant[] => [
  grant("gws.events_list", "*"),
  ...reads.map((operation) => grant("gws.read", `{account}:${operation}`)),
]

/** The operation of a `{account}:<operation>` resource, or the resource itself. */
const operation = (resource: string) => (resource.startsWith("{account}:") ? resource.slice("{account}:".length) : resource)

/** A name's tokens as Memory reads them: on `.`, `_` and `-`, then camelCase, lowercased. */
const tokens = (name: string) => name.split(/[_.-]+/).flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/)).map((part) => part.toLowerCase()).filter(Boolean)

describe("the memory declaration", () => {
  it("is schema v2 in the plugin's namespace, with both sources the code serves", () => {
    expect(memory.version).toBe(2)
    expect(memory.namespace).toBe("gws")
    expect(memory.sources.map((entry) => entry.id)).toEqual([GMAIL_SOURCE, CALENDAR_SOURCE])
  })

  it("declares exactly the grants Gmail's events_list asserts, with the setup line the code answers", () => {
    const gmail = source(GMAIL_SOURCE)
    expect(gmail.contract).toBe(2)
    expect(gmail.grants).toEqual(grantsOf(GMAIL_FOLLOW, GMAIL_READS))
    expect(gmail.setup).toBe(GMAIL_SETUP)
    expect(gmail.scope).toEqual([])
  })

  it("declares exactly the grants Calendar's events_list asserts, its scope key, and its setup line", () => {
    const calendar = source(CALENDAR_SOURCE)
    expect(calendar.contract).toBe(2)
    expect(calendar.grants).toEqual(grantsOf(CALENDAR_FOLLOW, CALENDAR_READS))
    expect(calendar.setup).toBe(CALENDAR_SETUP)
    expect(calendar.scope.map((entry) => entry.key)).toEqual(["calendars"])
    expect(memory.connector.scope.map((entry) => entry.key)).toEqual(["calendars"])
  })

  it("uses the identity read contract 2 allows, with the account and owner from the answer", () => {
    expect(memory.connector.identity.method).toBe("events_list")
    expect(memory.connector.identity.input).toEqual({ source: GMAIL_SOURCE, limit: 0 })
    expect(memory.connector.identity.grants).toEqual(grantsOf(GMAIL_FOLLOW, GMAIL_READS))
  })

  it("names only read verbs, and no write verb anywhere in an action or operation", () => {
    const grants = [...memory.sources.flatMap((entry) => entry.grants), ...memory.connector.reads.flatMap((read) => read.grants), ...memory.connector.identity.grants]
    expect(grants.length).toBeGreaterThan(0)
    for (const item of grants) {
      const tail = item.action.startsWith("gws.") ? item.action.slice("gws.".length) : item.action
      for (const token of [...tokens(tail), ...tokens(operation(item.resource))]) {
        expect(WRITES, `${item.action} ${item.resource}`).not.toContain(token)
      }
      if (item.action === "gws.read") {
        expect(READS).toContain(tokens(operation(item.resource).split(".").at(-1)!)[0])
      } else {
        expect(item.action).toBe("gws.events_list")
        expect(item.resource).toBe("*")
      }
      // A resource is `*` or an exact `{account}:<operation>`: never a wildcard over operations.
      expect(item.resource === "*" || /^\{account\}:[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(item.resource)).toBe(true)
    }
  })

  it("declares the direct read path with its exact grant, and no free-text scope", () => {
    expect(memory.connector.reads).toHaveLength(1)
    expect(memory.connector.reads[0]!.method).toBe("read")
    expect(memory.connector.reads[0]!.input).toEqual({ operation: CALENDAR_FOLLOW })
    expect(memory.connector.reads[0]!.grants).toEqual([grant("gws.read", `{account}:${CALENDAR_FOLLOW}`)])
  })

  it("declares only DSL templates that read their own source, with no script step", () => {
    expect(memory.templates.map((template) => template.id)).toEqual(["gmail-commitments", "calendar-meetings"])
    for (const template of memory.templates) {
      for (const step of template.extract.steps) {
        expect(Object.keys(step).sort()).toEqual(["source", "use"])
        expect(step["use"]).toBe("events_list")
        expect([GMAIL_SOURCE, CALENDAR_SOURCE]).toContain(step["source"])
      }
    }
  })
})
