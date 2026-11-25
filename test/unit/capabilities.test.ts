import { describe, expect, it } from "vitest"
import { readInstalledManifest } from "@we-the-rebel-alliance/plugin-contract/manifest"
import { renderGeneratedDocs } from "@we-the-rebel-alliance/plugin-contract/conformance"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const root = new URL("../../", import.meta.url).pathname

describe("capabilities", () => {
  const installed = readInstalledManifest(root)
  if (!installed.ok) throw new Error(installed.problems.join("; "))
  const manifest = installed.value.manifest

  it("is a valid v1 manifest for the gws package", () => {
    expect(manifest.plugin.name).toBe("gws")
    expect(installed.value.package).toBe("@we-the-rebel-alliance/gws-plugin")
    expect(manifest.plugin.summary.length).toBeLessThanOrEqual(300)
    expect(manifest.plugin.host).toEqual({ opencode: ">=2.4.1 <2.5.0", tested: ["2.4.1"] })
  })

  it("declares the 16 methods from the inventory", () => {
    expect(Object.keys(manifest.methods).sort()).toEqual(
      ["status", "catalog", "schema", "read", "plan", "events_list", "calendar_today", "images_read", "sheets_read", "probe", "write", "send", "share", "delete", "export", "admin"].sort(),
    )
    const byClass = Object.fromEntries(Object.entries(manifest.methods).map(([name, item]) => [name, item.class]))
    expect(byClass).toMatchObject({ status: "read", write: "write", send: "send", share: "share", delete: "delete", export: "export", admin: "admin" })
    for (const commit of ["write", "send", "share", "delete", "export", "admin"]) expect(manifest.methods[commit]?.commits).toBe("plan")
    expect(manifest.methods["plan"]?.plans).toBe(true)
  })

  it("declares one service per Google service and at least changed", () => {
    const services = Object.fromEntries(manifest.sources.map((source) => [source.id, source.service]))
    expect(services["gws.gmail"]).toEqual({ id: "gws.gmail", label: "Gmail" })
    expect(services["gws.calendar"]).toEqual({ id: "gws.calendar", label: "Calendar" })
    expect(services["gws.calendar.today"]).toEqual({ id: "gws.calendar", label: "Calendar" })
    expect(services["gws.image"]).toEqual({ id: "gws.drive", label: "Drive" })
    expect(services["gws.sheets"]).toEqual({ id: "gws.sheets", label: "Sheets" })
    expect(manifest.events).toEqual({ changed: {} })
  })

  it("names no tool that is not declared, and keeps every skill description within 300 characters", () => {
    const declared = new Set(Object.keys(manifest.methods))
    for (const file of readdirSync(join(root, "skills"))) {
      const text = readFileSync(join(root, "skills", file, "SKILL.md"), "utf8")
      const description = /^description:\s*(.+)$/m.exec(text)?.[1] ?? ""
      expect(description.length, file).toBeGreaterThan(0)
      expect(description.length, file).toBeLessThanOrEqual(300)
      for (const match of text.matchAll(/tools\.gws\.([a-z][a-z0-9_]*)/g)) expect(declared.has(match[1]!), match[1]).toBe(true)
      for (const match of text.matchAll(/\bgws_([a-z][a-z0-9_]*)/g)) expect(declared.has(match[1]!), match[1]).toBe(true)
    }
  })

  it("renders the generated sections the docs carry", () => {
    const sections = renderGeneratedDocs(manifest)
    const read = (file: string) => readFileSync(join(root, file), "utf8")
    expect(read("README.md")).toContain(sections.capabilities.trim().slice(0, 20))
    expect(read("docs/capabilities.md")).toContain(sections.capabilities.trim().slice(0, 20))
    expect(read("docs/configuration.md")).toContain(sections.configuration.trim())
    expect(read("docs/accounts.md")).toContain(sections.accounts.trim())
    expect(read("docs/automations.md")).toContain(sections.automations.trim())
  })
})
