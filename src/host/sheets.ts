import { GwsError } from "../domain/errors.js"
import type { CallContext } from "../runtime/accounts.js"
import type { Runtime } from "../runtime/index.js"

export const SHEETS_READ = { method: "sheets_read", action: "gws.sheets_read", source: "sheets" } as const
export const SHEETS_OPERATION = "sheets.spreadsheets.values.get"
/** The contract's ceiling in bytes, including the snapshot envelope. */
export const SHEETS_MAX_BYTES = 1_048_576
const MAX_CELLS = 100_000
const MAX_RANGE_LENGTH = 256
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{10,128}$/
// Only a sheet-qualified cell or a closed rectangle. Quote a title with spaces or punctuation; double apostrophes.
const A1 = /^(?:([\p{L}\p{N}_]+)|'((?:[^']|'')+)')!\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,7})(?::\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,7}))?$/u

export const SHEET_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["range", "sheet", "rows"],
  properties: {
    range: { type: "string", minLength: 1, maxLength: MAX_RANGE_LENGTH },
    sheet: { type: "string", minLength: 1, maxLength: MAX_RANGE_LENGTH },
    rows: { type: "array", items: { type: "array", items: { type: ["string", "number", "boolean"] } } },
  },
} as const

interface Range {
  sheet: string
  firstColumn: number
  lastColumn: number
  firstRow: number
  lastRow: number
}

type Cell = string | number | boolean
interface SheetValues {
  range: string
  sheet: string
  rows: Cell[][]
}

function column(letters: string): number {
  return [...letters.toUpperCase()].reduce((number, letter) => number * 26 + letter.charCodeAt(0) - 64, 0)
}

function parseRange(value: string): Range | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refuse control characters in the path parameter
  if (value.length > MAX_RANGE_LENGTH || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return
  const match = A1.exec(value)
  if (!match) return
  const [, bare, quoted, startCol, startRow, endCol, endRow] = match
  const sheet = bare ?? quoted!.replaceAll("''", "'")
  const firstColumn = column(startCol!)
  const lastColumn = endCol ? column(endCol) : firstColumn
  const firstRow = Number(startRow)
  const lastRow = endRow ? Number(endRow) : firstRow
  if (!sheet.trim() || firstColumn < 1 || lastColumn < firstColumn || lastRow < firstRow || lastRow > 10_000_000) return
  return { sheet, firstColumn, lastColumn, firstRow, lastRow }
}

function width(range: Range): number {
  return range.lastColumn - range.firstColumn + 1
}

function height(range: Range): number {
  return range.lastRow - range.firstRow + 1
}

interface SheetParams {
  spreadsheetId: string
  range: string
  bounds: Range
}

/** Validates the request before any permission check or provider access. */
export function sheetsParams({ spreadsheetId, range }: Readonly<Record<string, unknown>>): SheetParams {
  if (typeof spreadsheetId !== "string" || !SPREADSHEET_ID.test(spreadsheetId)) {
    throw new GwsError("INPUT_INVALID", `"spreadsheetId" must be the id from the spreadsheet's link, not the link itself`)
  }
  const bounds = typeof range === "string" ? parseRange(range) : undefined
  if (typeof range !== "string" || bounds === undefined) {
    throw new GwsError("INPUT_INVALID", `"range" must be a sheet-qualified A1 cell or closed rectangle, such as 'Q3 plan'!A1:D50`)
  }
  if (width(bounds) * height(bounds) > MAX_CELLS) {
    throw new GwsError("INPUT_INVALID", `"range" must cover at most ${MAX_CELLS} cells`, { next: "Read a smaller range." })
  }
  return { spreadsheetId, range, bounds }
}

export function sheetsTooLarge(): GwsError {
  return new GwsError("TOO_LARGE", `the Sheets snapshot exceeds ${SHEETS_MAX_BYTES} bytes`, { next: "Read a smaller range." })
}

function invalidAnswer(): never {
  throw new GwsError("GWS_API_ERROR", "Google did not return row values and range metadata matching the Sheets request", { next: "Retry once; if it fails again, report the error." })
}

function cell(value: unknown): value is Cell {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
}

/** Reads exactly one range as this account. Provider errors never echo the requested id, range or cells. */
export async function readSheet(runtime: Pick<Runtime, "read">, account: string, { spreadsheetId, range, bounds }: SheetParams, ctx: CallContext): Promise<SheetValues> {
  const result = await runtime.read({
    account,
    operation: SHEETS_OPERATION,
    params: { spreadsheetId, range, majorDimension: "ROWS", valueRenderOption: "FORMATTED_VALUE" },
    fields: "range,majorDimension,values",
    response: { mode: "full", maxInlineBytes: SHEETS_MAX_BYTES },
  }, ctx).catch((error: unknown) => {
    const known = GwsError.from(error)
    if (known?.code === "OUTPUT_LIMIT") {
      throw new GwsError("OUTPUT_LIMIT", "the Sheets read exceeded the configured process output limit", { next: "Read a smaller range." })
    }
    if (known?.code !== "GWS_API_ERROR") throw error
    if (known.status === 400 || known.status === 404) {
      throw new GwsError("INPUT_INVALID", "Google could not find the spreadsheet or read the named range", { next: "Check the spreadsheet id and range, and whether this account can open the spreadsheet." })
    }
    if (known.status === 403) {
      throw new GwsError("PERMISSION_DENIED", "Google refused this account's access to the requested range", { next: "Have the owner verify this configured account's access to the spreadsheet." })
    }
    const status = known.status
    throw new GwsError("GWS_API_ERROR", `Google's Sheets read failed${status === undefined ? "" : ` (HTTP ${status})`}`, { next: "Retry later.", ...(status === undefined ? {} : { status }) })
  })
  if (result.truncated) throw sheetsTooLarge()
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) invalidAnswer()
  const { range: resolved, majorDimension, values } = result.data as { range?: unknown; majorDimension?: unknown; values?: unknown }
  if (typeof resolved !== "string" || majorDimension !== "ROWS") invalidAnswer()
  const echoed = parseRange(resolved)
  if (
    echoed === undefined || echoed.sheet !== bounds.sheet || echoed.firstColumn !== bounds.firstColumn ||
    echoed.firstRow !== bounds.firstRow || echoed.lastColumn !== bounds.lastColumn || echoed.lastRow !== bounds.lastRow
  ) invalidAnswer()
  // Sheets omits trailing blanks, and may omit values altogether for an empty range. Do not pad, coerce or drop cells.
  if (values === undefined) return { range: resolved, sheet: echoed.sheet, rows: [] }
  if (!Array.isArray(values) || values.length > height(bounds)) invalidAnswer()
  const rows: Cell[][] = []
  for (const row of values) {
    if (!Array.isArray(row) || row.length > width(bounds) || !row.every(cell)) invalidAnswer()
    rows.push(row)
  }
  return { range: resolved, sheet: echoed.sheet, rows }
}
