import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { afterAll, describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "..", "..")

interface ExpectedSkill {
  readonly id: string
  readonly name: string
  readonly description: string
}

/** Every `skills/<id>/SKILL.md`, read the way the plugin reads it. */
function expectedSkills(): ExpectedSkill[] {
  const directory = join(root, "skills")
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => readFileSync(join(directory, id, "SKILL.md"), "utf8"))
    .sort()
    .map((id) => {
      const raw = readFileSync(join(directory, id, "SKILL.md"), "utf8")
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
      const front = match?.[1] ?? ""
      const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim()
      const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim()
      if (!match || !name || !description || !(match[2] ?? "").trim()) throw new Error(`the skill file skills/${id}/SKILL.md is invalid`)
      return { id, name, description }
    })
}

const skills = expectedSkills()
const scratch = mkdtempSync(join(tmpdir(), "gws-skills-host-"))

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/**
 * The built bundle in the real OpenCode 2.4.1 host, loaded as a plugin definition in an empty temp project. The plugin's
 * setup must register every `skills/<id>/SKILL.md` through `ctx.skill.transform`; stock discovery cannot find them,
 * because the project is empty and is not the package. A probe plugin captures the same host context so
 * `ctx.skill.list` is checked as well as the host's `skill.list`.
 */
describe("skills on OpenCode 2.4.1", () => {
  it("registers every skills/<id>/SKILL.md before the plugin becomes active", async () => {
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

    const contexts: Array<Parameters<ReturnType<typeof Plugin.define>["setup"]>[0]> = []
    const probe = Plugin.define({
      id: "gws.test.skill-probe",
      setup(ctx) {
        contexts.push(ctx)
      },
    })

    const { OpenCode } = await import("@opencode/sdk")
    const plugin = (await import(join(root, "dist/index.js"))).default
    const host = await OpenCode.create({
      plugins: [plugin, probe],
      config: { directory: project },
      app: { name: "opencode", version: "2.4.1" },
      log: { level: "error", emit: () => {} },
    })
    try {
      const location = { directory: project }
      const session = await host.sessions.create({ location, agent: "build", permissions: [] })
      await host.sessions.prompt({ sessionID: session.id, text: "activate the skills test", delivery: "queue" }).catch(() => undefined)

      const deadline = Date.now() + 30_000
      let listed: Array<{ id: string; name: string; description?: string }> = []
      while (Date.now() < deadline) {
        const answer = await host.skill.list({ location }).catch(() => undefined)
        listed = answer?.data ?? []
        if (skills.every((skill) => listed.some((entry) => entry.id === skill.id))) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      expect([...listed.map((entry) => entry.id)].sort()).toEqual(expect.arrayContaining(skills.map((skill) => skill.id)))
      for (const skill of skills) {
        const entry = listed.find((candidate) => candidate.id === skill.id)
        expect(entry, `the host did not list ${skill.id}`).toBeDefined()
        expect(entry?.name).toBe(skill.name)
        expect(entry?.description).toBe(skill.description)
      }

      expect(contexts.length).toBeGreaterThan(0)
      const context = contexts[contexts.length - 1]!
      const fromContext = await context.skill.list({ location })
      for (const skill of skills) {
        const entry = fromContext.data.find((candidate) => candidate.id === skill.id)
        expect(entry, `ctx.skill.list did not list ${skill.id}`).toBeDefined()
        expect(entry?.description).toBe(skill.description)
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
