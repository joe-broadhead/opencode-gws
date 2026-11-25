import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Skill } from "@opencode/plugin"
import type { Plugin } from "@opencode/plugin"
import { GwsError } from "./provider/domain/errors.js"

/**
 * The package's hand-written skills. The skill directory is the one source of the id list: every `skills/<id>/SKILL.md`
 * is registered, in sorted order. `import.meta.url` is rewritten by the bundle to `dist/skills.js`, so `..` is the
 * package root in both the source tree and the installed bundle.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SKILLS = join(ROOT, "skills")

export interface ParsedSkill {
  readonly name: string
  readonly description: string
  readonly content: string
}

/** Every skill directory, sorted by id. */
export function skillIds(directory = SKILLS): string[] {
  if (!existsSync(directory)) throw new Error(`SKILLS_INVALID: the skills directory ${directory} is missing from the package`)
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => existsSync(join(directory, id, "SKILL.md")))
    .sort()
}

/** A skill file's frontmatter and body; the name must equal its directory, and the description and body must be non-empty. */
export function parseSkill(raw: string, id: string, file: string): ParsedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  const front = match?.[1] ?? ""
  const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim()
  const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim()
  const content = (match?.[2] ?? "").trim()
  if (!match || !name || !description) throw new Error(`SKILLS_INVALID: the skill file ${file} has no name and description frontmatter`)
  if (name !== id) throw new Error(`SKILLS_INVALID: the skill file ${file} names "${name}", not its directory "${id}"`)
  if (description.length === 0) throw new Error(`SKILLS_INVALID: the skill file ${file} has an empty description`)
  if (description.startsWith(">") || description.startsWith("|")) {
    throw new GwsError("SKILLS_INVALID", `The skill file ${file} has a block-scalar description (${description}); descriptions must be one line.`, {
      next: "Put the description on one line after `description:`; do not use > or |.",
    })
  }
  if (content.length === 0) throw new Error(`SKILLS_INVALID: the skill file ${file} has no content`)
  return { name, description, content }
}

/** Register every `skills/<id>/SKILL.md` with OpenCode. */
export async function registerSkills(ctx: Pick<Plugin.Context, "skill">): Promise<number> {
  const ids = skillIds()
  if (ids.length === 0) throw new Error(`SKILLS_INVALID: the package has no skills in ${SKILLS}`)
  let registered = 0
  await ctx.skill.transform((editor) => {
    for (const id of ids) {
      const file = `skills/${id}/SKILL.md`
      const path = join(SKILLS, id, "SKILL.md")
      const parsed = parseSkill(readFileSync(path, "utf8"), id, file)
      editor.add({
        id: Skill.ID.make(id),
        name: Skill.Name.make(parsed.name),
        description: parsed.description,
        path: Skill.Info.fields.path.make(path),
        content: parsed.content,
        autoinvoke: true,
      })
      registered += 1
    }
  })
  return registered
}
