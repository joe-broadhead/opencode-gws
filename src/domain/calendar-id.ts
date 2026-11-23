import { createHash } from "node:crypto"

/**
 * Google's event id, or the common deterministic `sha256:` digest of an id longer than `max` characters. The prefix
 * contains `:`, outside Google's base32hex (`0-9a-v`) id alphabet, so no provider id can collide with a mapped one.
 * The mapping is collision-resistant and never truncates; an in-limit id is kept exactly. `calendar.today` and
 * `events_list` share it, so one long provider id names the same event in both.
 */
export function stableEventId(id: string, max: number): string {
  return id.length <= max ? id : `sha256:${createHash("sha256").update(id).digest("hex")}`
}
