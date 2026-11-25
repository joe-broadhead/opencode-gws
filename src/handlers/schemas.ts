import * as z from "zod"
import { STATUS_SCHEMA } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { EVENTS_LIST_INPUT_SCHEMA, PAGE_SCHEMA, PROBE_SCHEMA } from "@we-the-rebel-alliance/plugin-contract/events"
import type { JsonSchema } from "@we-the-rebel-alliance/plugin-contract/manifest"
import { CatalogInput, CatalogOutput, ReadOutput, RequestInput, SchemaInput, SchemaOutput } from "../provider/domain/contract.js"

/**
 * The handler table's schemas. Inputs omit `account`: the register adds the selector to every method declared
 * `accounts: "optional"`. The status, page and probe answers are the contract's own schemas, never a copy.
 */
function json(schema: z.ZodType): JsonSchema {
  const { $schema: _schema, ...rest } = z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" }) as Record<string, unknown>
  return rest as JsonSchema
}


export const STATUS_OUTPUT = STATUS_SCHEMA
export const PAGE_OUTPUT = PAGE_SCHEMA
export const PROBE_OUTPUT = PROBE_SCHEMA

export const CATALOG_INPUT = json(CatalogInput)
export const CATALOG_OUTPUT = json(CatalogOutput)
export const SCHEMA_INPUT = json(SchemaInput.omit({ account: true }))
export const SCHEMA_OUTPUT = json(SchemaOutput)
export const READ_INPUT = json(RequestInput.omit({ account: true }))
export const READ_OUTPUT = json(ReadOutput)
export const PLAN_INPUT = json(RequestInput.omit({ account: true }))
export const EVENTS_INPUT = EVENTS_LIST_INPUT_SCHEMA
export const PROBE_INPUT: JsonSchema = {
  type: "object",
  properties: { source: { type: "string", description: "A declared source name: gmail, calendar, calendar-today, image or sheets." } },
  additionalProperties: false,
}
export const CALENDAR_TODAY_INPUT: JsonSchema = {
  type: "object",
  properties: { source: { const: "calendar-today" } },
  additionalProperties: false,
}
export const IMAGES_READ_INPUT: JsonSchema = {
  type: "object",
  properties: {
    source: { const: "image" },
    url: { type: "string", minLength: 9, maxLength: 2048, description: "A Drive file link, or an address on Google's image servers that Google returned to the account." },
  },
  required: ["url"],
  additionalProperties: false,
}

const ENVELOPE: JsonSchema = {
  type: "object",
  required: ["data", "asOf", "trust"],
  properties: {
    data: { type: "object" },
    asOf: { type: "string" },
    cost: { type: "object" },
    trust: { const: "untrusted" },
  },
  additionalProperties: false,
}

export const SNAPSHOT_OUTPUT = ENVELOPE
export const PLAN_OUTPUT: JsonSchema = { type: "object", additionalProperties: true }

const FileInfo = z.object({ path: z.string(), bytes: z.number(), sha256: z.string() })
export const COMMIT_OUTPUT = json(
  z.object({
    ok: z.literal(true),
    category: z.enum(["write", "send", "share", "delete", "export", "admin"]),
    operation: z.string(),
    result: z.unknown(),
    file: FileInfo.optional(),
    cleanupDegraded: z.boolean().optional(),
  }),
)
