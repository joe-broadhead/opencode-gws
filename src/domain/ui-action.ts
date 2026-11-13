import * as z from "zod"
import { GwsError } from "./errors.js"

/**
 * The one change a person may approve from a UI an agent made in Jelly: Jelly's `commit` action (`package.json`
 * `jelly.actions`), plan-shaped. Its input is a gws plan request, its preview is gws's own dry run of that exact
 * request, and the agent's door to the same change is `gws_plan` then `gws_write`. This release allows one operation,
 * a Sheets value update, and only when the `uiActions` option lists it (empty by default).
 *
 * This module is the gws-specific half: what may run, its input, the words of its preview and what its answer says
 * changed. The grant check is generic (`src/host/action-grant.ts`).
 */

/** The operations the `uiActions` option may list. A later release adds one here; nobody gets it until they list it. */
export const UI_ACTION_OPERATIONS = ["sheets.spreadsheets.values.update"] as const
export type UiActionOperation = (typeof UI_ACTION_OPERATIONS)[number]

/** The action's name in Jelly (`act.commit`) and its preview method. */
export const UI_ACTION = "commit"
export const UI_PREVIEW_METHOD = "plan.preview"

/** Jelly's caps: a confirmation's preview text (`ACTION_PREVIEW_MAX_CHARS`). */
export const UI_PREVIEW_MAX_CHARS = 4000
/** How many rows, cells per row and characters per cell one change may carry. */
export const UI_MAX_ROWS = 100
export const UI_MAX_COLUMNS = 26
export const UI_MAX_CELL_CHARS = 500

/**
 * The action's input, as Jelly checks it (JSON Schema, no `pattern`: OpenCode refuses every call to a method that has
 * one). `package.json` declares the same document (test/ui-action.test.ts).
 */
export const UI_CHANGE_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["account", "operation", "params", "body"],
  properties: {
    account: { type: "string", minLength: 1, maxLength: 64 },
    operation: { type: "string", enum: [...UI_ACTION_OPERATIONS] },
    params: {
      type: "object",
      additionalProperties: false,
      required: ["spreadsheetId", "range", "valueInputOption"],
      properties: {
        spreadsheetId: { type: "string", minLength: 1, maxLength: 200 },
        range: { type: "string", minLength: 1, maxLength: 200 },
        valueInputOption: { type: "string", enum: ["RAW"] },
      },
    },
    body: {
      type: "object",
      additionalProperties: false,
      required: ["values"],
      properties: {
        majorDimension: { type: "string", enum: ["ROWS", "COLUMNS"] },
        values: {
          type: "array",
          minItems: 1,
          maxItems: UI_MAX_ROWS,
          items: {
            type: "array",
            maxItems: UI_MAX_COLUMNS,
            items: { anyOf: [{ type: "string", maxLength: UI_MAX_CELL_CHARS }, { type: "number" }, { type: "boolean" }] },
          },
        },
      },
    },
  },
} as const

/** What the action answers: what Google says it changed. */
export const UI_CHANGE_OUTPUT = {
  type: "object",
  additionalProperties: false,
  required: ["account", "operation", "spreadsheetId", "updatedRange", "updatedRows", "updatedColumns", "updatedCells"],
  properties: {
    account: { type: "string", minLength: 1, maxLength: 64 },
    operation: { type: "string", enum: [...UI_ACTION_OPERATIONS] },
    spreadsheetId: { type: "string", maxLength: 200 },
    updatedRange: { type: "string", maxLength: 200 },
    updatedRows: { type: "integer", minimum: 0 },
    updatedColumns: { type: "integer", minimum: 0 },
    updatedCells: { type: "integer", minimum: 0 },
  },
} as const

/** The preview's answer: gws's words, as plain text. */
export const UI_PREVIEW_OUTPUT = { type: "string", minLength: 1, maxLength: UI_PREVIEW_MAX_CHARS } as const

const cell = z.union([z.string().max(UI_MAX_CELL_CHARS), z.number().finite(), z.boolean()])

/** The plugin's own check of the same shape: it never relies on Jelly having checked. */
const UiChange = z.strictObject({
  account: z.string().min(1).max(64),
  operation: z.enum(UI_ACTION_OPERATIONS),
  params: z.strictObject({
    spreadsheetId: z.string().min(1).max(200),
    range: z.string().min(1).max(200),
    valueInputOption: z.literal("RAW"),
  }),
  body: z.strictObject({
    majorDimension: z.enum(["ROWS", "COLUMNS"]).optional(),
    values: z.array(z.array(cell).max(UI_MAX_COLUMNS)).min(1).max(UI_MAX_ROWS),
  }),
})
export type UiChange = z.infer<typeof UiChange>

const REFUSED_NEXT = "Make the change with gws_plan and gws_write instead, or tell the user why it was refused."

/**
 * The input as a change the action may make, or `UI_ACTION_REFUSED` (another operation, another shape). Checked
 * before the option, so an operation outside the list is named as one this action never makes.
 */
export function uiChange(input: unknown): UiChange {
  const operation = input !== null && typeof input === "object" ? (input as { operation?: unknown }).operation : undefined
  if (!(UI_ACTION_OPERATIONS as readonly unknown[]).includes(operation)) {
    throw new GwsError("UI_ACTION_REFUSED", "a UI may ask only for a Sheets value update (sheets.spreadsheets.values.update)", { next: REFUSED_NEXT })
  }
  const parsed = UiChange.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")
    throw new GwsError("UI_ACTION_REFUSED", `the change is not the shape the action takes (${issues})`, { next: REFUSED_NEXT })
  }
  return parsed.data
}

/** The options' gate: the operation is listed in `uiActions`, and `access` lets changes run. */
export function uiAllowed(config: { readonly uiActions: readonly string[]; readonly access: string }, change: UiChange): void {
  if (!config.uiActions.includes(change.operation)) {
    throw new GwsError("UI_ACTION_OFF", `the uiActions option does not list ${change.operation}`)
  }
  if (config.access === "read-only") {
    throw new GwsError("UI_ACTION_REFUSED", "access is read-only, so nothing changes, whichever surface asks", {
      next: "Tell the user; they can change the plugin's access setting.",
    })
  }
}

/** The part of gws's plan the preview shows: its own redacted preview of the command. */
export interface PlanView {
  readonly category: string
  readonly preview: { readonly method: string; readonly url?: string | null; readonly account: string; readonly category: string }
}

const quoted = (value: string | number | boolean) => JSON.stringify(value)

/**
 * The preview a person confirms: gws's plan of the exact change (category, account, method and address) and every
 * cell it writes, in order. The values are the input's own, shown to the person and never logged. A preview over
 * Jelly's cap is refused rather than cut short, so nobody approves cells they could not see.
 */
export function previewText(plan: PlanView, change: UiChange): string {
  const dimension = change.body.majorDimension ?? "ROWS"
  const lines = [
    `gws plan (a dry run; nothing has changed yet): ${plan.category} · ${change.operation}`,
    `Account: ${plan.preview.account}`,
    `Request: ${plan.preview.method} ${plan.preview.url ?? ""}`.trimEnd(),
    `Spreadsheet: ${change.params.spreadsheetId}`,
    `Range: ${change.params.range}`,
    "Values are stored exactly as written (RAW), never as formulas.",
    `${dimension === "ROWS" ? "Rows" : "Columns"} to write (${change.body.values.length}):`,
    ...change.body.values.map((row, index) => `${index + 1}. ${row.length === 0 ? "(empty)" : row.map(quoted).join(" | ")}`),
  ]
  const text = lines.join("\n")
  if (text.length > UI_PREVIEW_MAX_CHARS) {
    throw new GwsError("UI_ACTION_REFUSED", `the preview of this change is ${text.length} characters, more than the ${UI_PREVIEW_MAX_CHARS} Jelly's confirmation shows`, {
      next: "Ask for a smaller change, or make it with gws_plan and gws_write.",
    })
  }
  return text
}

const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0)
const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 200) : "")

/** What Google says the update changed (its `UpdateValuesResponse`), for Jelly to word the receipt from. */
export function changed(change: UiChange, result: unknown) {
  const answer = (result !== null && typeof result === "object" ? result : {}) as Record<string, unknown>
  return {
    account: change.account,
    operation: change.operation,
    spreadsheetId: text(answer.spreadsheetId),
    updatedRange: text(answer.updatedRange),
    updatedRows: count(answer.updatedRows),
    updatedColumns: count(answer.updatedColumns),
    updatedCells: count(answer.updatedCells),
  }
}
