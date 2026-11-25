import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { afterAll, describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"

const root = join(fileURLToPath(new URL("../..", import.meta.url)))

interface ExpectedSkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly path: string
  readonly content: string
}

/** Every `skills/<id>/SKILL.md`, parsed as YAML: the independent source of truth for what the host must register. */
function expectedSkills(): ExpectedSkill[] {
  const directory = join(root, "skills")
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((id) => {
      const path = join(directory, id, "SKILL.md")
      const text = readFileSync(path, "utf8")
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
      if (!match) throw new Error(`the skill file skills/${id}/SKILL.md has no frontmatter`)
      const fields = parseYaml(match[1] ?? "") as Record<string, unknown>
      if (fields.name !== id) throw new Error(`the skill file skills/${id}/SKILL.md names "${String(fields.name)}", not its directory`)
      if (typeof fields.description !== "string" || fields.description.trim() === "") throw new Error(`the skill file skills/${id}/SKILL.md has no description`)
      if (["", ">", "|", ">-", "|-", ">+", "|+"].includes(fields.description.trim())) {
        throw new Error(`the skill file skills/${id}/SKILL.md registers a block marker, not its text`)
      }
      return { id, name: fields.name as string, description: fields.description, path, content: text.slice(match[0].length).trim() }
    })
}

const skills = expectedSkills()
const scratch = mkdtempSync(join(tmpdir(), "gws-skills-host-"))

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/**
 * The built bundle in the real OpenCode 2.4.1 host, loaded through the host's package resolver in an empty temp
 * project. The plugin's setup must register every `skills/<id>/SKILL.md` through `ctx.skill.transform`; stock
 * discovery cannot find them, because the project is empty and is not the package. A probe plugin captures the same
 * host context so `ctx.skill.list` is checked as well as the host's `skill.list`.
 */
describe("skills on OpenCode 2.4.1", () => {
  it("registers every skills/<id>/SKILL.md with the YAML description", async () => {
    const project = join(scratch, "project")
    const home = join(scratch, "home")
    for (const directory of [project, home, join(home, "config"), join(home, "cache"), join(home, "data"), join(home, "state")]) {
      mkdirSync(directory, { recursive: true })
    }
    // Stock discovery looks in `<project>/skills`; the project is empty, so a listing can only come from transform.
    expect(project.startsWith(`${root}/`)).toBe(false)
    expect(readdirSync(project)).toEqual([])

    const saved = new Map<string, string | undefined>()
    const setEnv = (key: string, value: string | undefined) => {
      if (!saved.has(key)) saved.set(key, process.env[key])
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    setEnv("HOME", home)
    setEnv("OPENCODE_TEST_HOME", home)
    setEnv("XDG_CONFIG_HOME", join(home, "config"))
    setEnv("XDG_CACHE_HOME", join(home, "cache"))
    setEnv("XDG_DATA_HOME", join(home, "data"))
    setEnv("XDG_STATE_HOME", join(home, "state"))
    setEnv("TMPDIR", join(home, "tmp"))
    mkdirSync(join(home, "tmp"), { recursive: true })
    for (const key of Object.keys(process.env)) if (key.startsWith("OPENCODE")) setEnv(key, undefined)
    setEnv("OPENCODE_TEST_HOME", home)

    const contexts: Plugin.Context[] = []
    const probe = Plugin.define({
      id: "gws.test.skill-probe",
      setup(ctx) {
        contexts.push(ctx)
      },
    })

    const { OpenCode } = await import("@opencode/sdk")
    const { load, resolve } = await import("@opencode/plugin/host")
    const { waitForActivation } = await import("@we-the-rebel-alliance/plugin-contract/kit")
    const entry = resolve({ directory: root }).server
    expect(entry).toBeDefined()
    const module = (await load(entry!)) as { readonly default?: Plugin.Plugin }
    const definition = module.default
    expect(definition).toBeDefined()
    const host = await OpenCode.create({
      plugins: [definition!, probe],
      config: { directory: project },
      app: { name: "opencode", version: "2.4.1" },
      log: { level: "error", emit: () => {} },
    })
    try {
      const location = { directory: project }
      const session = await host.sessions.create({ location, agent: "build", permissions: [] })
      await host.sessions.prompt({ sessionID: session.id, text: "activate the skills test", delivery: "queue" }).catch(() => undefined)
      await waitForActivation({
        isActive: async () => {
          const list = await host.plugin.list({ location }).catch(() => undefined)
          return list?.data.some((candidate: { readonly id?: string }) => candidate.id === definition!.id) ?? false
        },
        timeoutMs: 20_000,
      })

      const answer = await host.skill.list({ location })
      for (const skill of skills) {
        expect(skill.name).toBe(skill.id)
        expect(skill.description.trim()).not.toMatch(/^[>|]/)
        const registered = answer.data.find((candidate: { readonly id: string }) => candidate.id === skill.id)
        expect(registered, `the host did not list ${skill.id}`).toBeDefined()
        expect(registered?.name).toBe(skill.id)
        expect(registered?.path).toBe(skill.path)
        expect(registered?.content.trim().length).toBeGreaterThan(0)
        expect(registered?.description).toBe(skill.description)
      }

      expect(contexts.length).toBeGreaterThan(0)
      const context = contexts[contexts.length - 1]!
      const fromContext = await context.skill.list({ location })
      for (const skill of skills) {
        expect(fromContext.data.find((candidate: { readonly id: string }) => candidate.id === skill.id)?.description).toBe(skill.description)
      }
    } finally {
      await host.close()
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
