import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin"
import { describe, expect, it } from "vitest"
import { readSkills, registerSkills } from "../../src/skills.js"

const root = join(fileURLToPath(new URL("../..", import.meta.url)))

/** A temporary `skills/` directory holding one file per entry. */
function fixture(files: Readonly<Record<string, string>>): string {
  const directory = mkdtempSync(join(tmpdir(), "gws-skills-"))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(directory, name), { recursive: true })
    writeFileSync(join(directory, name, "SKILL.md"), text)
  }
  return directory
}

describe("skill loader", () => {
  it("checks the packaged skills, their YAML descriptions and their bodies", () => {
    const skills = readSkills()
    expect(skills.map((skill) => skill.id)).toEqual(["gws", "gws-recipes"])
    const gws = skills.find((skill) => skill.id === "gws")!
    expect(gws.name).toBe("gws")
    expect(gws.description).toMatch(/^The user's Gmail, Calendar, Drive, Docs, Sheets, Tasks and other Google Workspace data, and how/)
    expect(gws.description).toMatch(/accounts, plan then commit/)
    expect(gws.content).toMatch(/^If Google Workspace tools are absent/)
    expect(gws.content).toContain("# Google Workspace")
    expect(gws.content.startsWith("---")).toBe(false)
    expect(gws.path).toBe(join(root, "skills", "gws", "SKILL.md"))
    const recipes = skills.find((skill) => skill.id === "gws-recipes")!
    expect(recipes.name).toBe("gws-recipes")
    expect(recipes.description).toMatch(/^Ready gws requests for everyday tasks, including recent or unread mail/)
    expect(recipes.content).toContain("# Recipes")
    expect(recipes.path).toBe(join(root, "skills", "gws-recipes", "SKILL.md"))
  })

  it("accepts YAML block scalars as folded, literal or stripped text", () => {
    const cases: readonly [string, string, string][] = [
      ["folded", ">", "first line second line\n"],
      ["literal", "|", "first line\nsecond line\n"],
      ["folded-strip", ">-", "first line second line"],
      ["literal-strip", "|-", "first line\nsecond line"],
    ]
    for (const [name, marker, expected] of cases) {
      const directory = fixture({ [name]: `---\nname: ${name}\ndescription: ${marker}\n  first line\n  second line\n---\n\n# Body\n` })
      try {
        expect(readSkills(directory)[0]?.description).toBe(expected)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
    const empty = fixture({ empty: "---\nname: empty\ndescription: >\n---\n\n# Body\n" })
    try {
      expect(() => readSkills(empty)).toThrow(/has no frontmatter description/)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
    const marker = fixture({ marker: "---\nname: marker\ndescription: '>'\n---\n\n# Body\n" })
    try {
      expect(() => readSkills(marker)).toThrow(/only a block marker/)
    } finally {
      rmSync(marker, { recursive: true, force: true })
    }
    const broken = fixture({ broken: "---\nname: broken\ndescription: [unclosed\n---\n\n# Body\n" })
    try {
      expect(() => readSkills(broken)).toThrow(/has frontmatter that is not valid YAML/)
    } finally {
      rmSync(broken, { recursive: true, force: true })
    }
  })

  it("requires the frontmatter shape the plugin registers", () => {
    const cases: readonly [string, Readonly<Record<string, string>>, RegExp][] = [
      ["no frontmatter", { broken: "# Broken\n" }, /SKILLS_INVALID: skills\/broken\/SKILL.md has no frontmatter\. Next step: /],
      ["no name", { broken: "---\ndescription: A description.\n---\n\n# Body\n" }, /has no frontmatter name/],
      ["another name", { broken: "---\nname: other\ndescription: A description.\n---\n\n# Body\n" }, /names "other", not its directory "broken"/],
      ["no description", { broken: "---\nname: broken\n---\n\n# Body\n" }, /has no frontmatter description/],
      ["empty content", { broken: "---\nname: broken\ndescription: A description.\n---\n\n" }, /has no content below its frontmatter/],
    ]
    for (const [name, files, expected] of cases) {
      const directory = fixture(files)
      try {
        expect(() => readSkills(directory), name).toThrow(expected)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
    const missing = mkdtempSync(join(tmpdir(), "gws-skills-"))
    try {
      mkdirSync(join(missing, "empty"), { recursive: true })
      expect(() => readSkills(missing)).toThrow(/skills\/empty\/SKILL.md is missing/)
    } finally {
      rmSync(missing, { recursive: true, force: true })
    }
    const none = mkdtempSync(join(tmpdir(), "gws-skills-"))
    try {
      expect(() => readSkills(none)).toThrow(/skills\/ holds no <name>\/SKILL\.md/)
    } finally {
      rmSync(none, { recursive: true, force: true })
    }
  })

  it("registerSkills adds every checked skill and returns a disposer", async () => {
    const added: { id: string; name: string; description?: string; path: string; content: string }[] = []
    let disposed = false
    const context = {
      skill: {
        async transform(callback: (editor: { add: (skill: (typeof added)[number]) => void }) => void) {
          callback({ add: (skill) => added.push(skill) })
          return {
            async dispose() {
              disposed = true
            },
          }
        },
      },
    } as unknown as Plugin.Context
    const registration = await registerSkills(context)
    expect(added.map((skill) => skill.id)).toEqual(["gws", "gws-recipes"])
    for (const skill of added) {
      expect(skill.name).toBe(skill.id)
      expect(skill.description?.trim()).not.toBe("")
      expect(skill.path).toBe(join(root, "skills", skill.id, "SKILL.md"))
      expect(skill.content.trim()).not.toBe("")
    }
    await registration.dispose()
    expect(disposed).toBe(true)
  })
})
