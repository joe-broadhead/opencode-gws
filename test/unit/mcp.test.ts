import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { refuseGmailMcp } from "../../src/handlers/mcp.js"
import { manifest } from "../../src/manifest.js"
import { catalog, commandIndex } from "../../src/provider/domain/manifest.js"
import { GMAIL_MCP_COVERAGE, gmailMcpNextStep, gmailMcpOperations } from "../../src/provider/domain/mcp.js"
import type { Runtime } from "../../src/provider/index.js"

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

const interactive = { gmailOnMcp: () => true } as unknown as Runtime
const headless = { gmailOnMcp: () => false } as unknown as Runtime

describe("Google's Gmail MCP server", () => {
  it("is recorded in the README with its link and the date checked", () => {
    const readme = read("../../README.md").replace(/\s+/gu, " ")
    expect(readme).toContain("## Google's MCP server")
    expect(readme).toContain("https://developers.google.com/workspace/guides/configure-mcp-servers")
    expect(readme).toContain("checked on 28 November 2026")
    expect(readme).toContain("https://gmailmcp.googleapis.com/mcp/v1")
    expect(readme).toContain("Use this client for an AI-powered agent")
  })

  it("names only operations the pinned catalog has", () => {
    const index = commandIndex()
    for (const operation of gmailMcpOperations()) {
      expect(index.methods.has(operation) || index.helpers.has(operation), operation).toBe(true)
    }
  })

  it("declares every covered tool, and only tools it covers", () => {
    const declared = new Set(Object.keys(manifest.methods).filter((method) => method.startsWith("mcp:")).map((method) => method.slice(4)))
    const covered = new Set(Object.values(GMAIL_MCP_COVERAGE).flatMap((entry) => entry.tools))
    expect([...declared].sort()).toEqual([...covered].sort())
    expect(manifest.methods["mcp:*"]).toBeUndefined()
  })

  it("takes the covered operations out of read and the plans the server replaces", () => {
    const covered = new Set(gmailMcpOperations())
    for (const method of ["read", "plan_write", "plan_send", "plan_delete", "write", "send", "delete"]) {
      const operations = manifest.methods[method]?.operations ?? []
      expect(operations.filter((operation) => covered.has(operation)), method).toEqual([])
    }
    // An export to a file is an act Google's server does not offer, so the export class keeps the Gmail reads.
    expect(manifest.methods["export"]?.operations).toContain("gmail.users.messages.get")
    expect(manifest.methods["plan_export"]?.operations).toContain("gmail.users.messages.list")
    // The Gmail source still reads history through the plugin's own pipeline.
    const source = manifest.sources.find((entry) => entry.id === "gws.gmail")
    expect(source?.operations).toContain("gmail.users.history.list")
  })

  it("refuses a covered operation only for an interactive account, and names the alias's tool", () => {
    expect(() => refuseGmailMcp(interactive, "gmail.users.messages.send", "work", "plan_send")).toThrow(
      /^MCP_HANDOFF: Gmail\.users\.messages\.send is served by Google's Gmail MCP server, and plan_send no longer runs it\. Next step: Call `gws-work_send_message` instead/,
    )
    expect(() => refuseGmailMcp(headless, "gmail.users.messages.send", "work", "plan_send")).not.toThrow()
    expect(() => refuseGmailMcp(interactive, "drive.files.list", "work", "read")).not.toThrow()
    expect(() => refuseGmailMcp(interactive, "gmail.users.messages.get", "work", "plan_export")).not.toThrow()
    expect(() => refuseGmailMcp(interactive, "gmail.users.messages.get", "work", "plan_admin")).not.toThrow()
  })

  it("hides a covered operation from the catalog and keeps one the server does not cover", () => {
    const hidden = new Set(gmailMcpOperations())
    const covered = catalog({ query: "gmail messages list", include: ["methods"] }, undefined, hidden)
    expect(covered.entries.some((entry) => entry.id === "gmail.users.messages.list")).toBe(false)
    const history = catalog({ query: "gmail history list", include: ["methods"] }, undefined, hidden)
    expect(history.entries.some((entry) => entry.id === "gmail.users.history.list")).toBe(true)
  })

  it("names every alternative tool for an operation several tools serve", () => {
    const next = gmailMcpNextStep("gmail.users.messages.modify", "gws")
    expect(next).toContain("`gws_update_message_labels`")
    expect(next).toContain("or `gws_unmark_message_spam`")
    expect(gmailMcpNextStep("gmail.users.settings.getVacation", "gws")).toBeUndefined()
  })
})
