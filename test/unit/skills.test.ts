import { describe, expect, it } from "vitest"
import { parseSkill } from "../../src/skills.js"

/**
 * The skill frontmatter is one line per field. A YAML block scalar registers the marker as the description, so the
 * parser refuses it rather than making the skill disappear.
 */
describe("skill frontmatter", () => {
  it("rejects a block-scalar description with a one-line next step", () => {
    for (const marker of [">", ">-", ">+", "|", "|-", "|+"]) {
      const raw = `---\nname: gws\ndescription: ${marker}\n  folded text\n---\n\nBody.\n`
      expect(() => parseSkill(raw, "gws", "skills/gws/SKILL.md")).toThrow(/SKILLS_INVALID: .*block-scalar.*Next step: .*one line/)
    }
  })
})
