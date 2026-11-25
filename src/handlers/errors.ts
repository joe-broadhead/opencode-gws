import { refusal, RegisterError } from "@we-the-rebel-alliance/plugin-contract/register"
import { GwsError } from "../provider/domain/errors.js"

/**
 * The provider's own refusals in the contract's table. A code the contract does not define is `UNAVAILABLE`, with the
 * provider's next step kept; a sign-in failure becomes `NEEDS_SIGN_IN`, never the old transport's `AUTH_REQUIRED`.
 */
const CODES: Readonly<Record<string, string>> = {
  AUTH_REQUIRED: "NEEDS_SIGN_IN",
  AUTH_SCOPE_MISSING: "SCOPE_MISSING",
  ACCOUNT_REQUIRED: "ACCOUNT_REQUIRED",
  ACCOUNT_UNKNOWN: "ACCOUNT_UNKNOWN",
  CURSOR_INVALID: "CURSOR_INVALID",
  INPUT_INVALID: "INPUT_INVALID",
  GWS_VALIDATION_ERROR: "INPUT_INVALID",
  FIELDS_INVALID: "INPUT_INVALID",
  UPLOAD_INVALID: "INPUT_INVALID",
  DOWNLOAD_INVALID: "INPUT_INVALID",
  SOURCE_UNKNOWN: "SOURCE_UNKNOWN",
  TOO_LARGE: "TOO_LARGE",
  POLICY_DENIED: "PERMISSION_DENIED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  RECIPIENTS_UNKNOWN: "PERMISSION_DENIED",
  ACCOUNT_DOMAIN_UNKNOWN: "PERMISSION_DENIED",
  ADMIN_PRIVILEGE_REQUIRED: "PERMISSION_DENIED",
  PLAN_INVALID: "PLAN_INVALID",
  PLAN_USED: "PLAN_USED",
  PLAN_NOT_FOUND: "PLAN_INVALID",
  PLAN_EXPIRED: "PLAN_INVALID",
  PLAN_CALLER_MISMATCH: "PLAN_INVALID",
  CATEGORY_MISMATCH: "PLAN_INVALID",
  PLAN_ALREADY_USED: "PLAN_USED",
  HOST_UNTESTED: "HOST_UNTESTED",
  OPTIONS_INVALID: "OPTIONS_INVALID",
}

const DEFAULT_NEXT: Readonly<Record<string, string>> = {
  NEEDS_SIGN_IN: "Sign the account in, then call again.",
  SCOPE_MISSING: "Sign in again and approve the scope the operation needs.",
  ACCOUNT_REQUIRED: "Pass account with one of the aliases status lists.",
  ACCOUNT_UNKNOWN: "Pass an alias status lists.",
  CURSOR_INVALID: "Read again without a cursor, or with since.",
  INPUT_INVALID: "Fix the input as the message says, then call again.",
  SOURCE_UNKNOWN: "Pass a source the plugin declares.",
  TOO_LARGE: "Read a smaller range or picture.",
  PERMISSION_DENIED: "Do not work around it; ask the person to change the policy or the access level.",
  PLAN_INVALID: "Plan the change again, then commit the new planId.",
  PLAN_USED: "Check the result with read before planning again.",
  UNAVAILABLE: "Try again; if it keeps failing, read status.",
}

interface Refusal {
  code: string
  what: string
  next: string
}

/** A thrown value's code, what happened and its next step, from its message when it is not a GwsError. */
function refusalOf(error: unknown): Refusal | undefined {
  const known = GwsError.from(error)
  if (known) return { code: CODES[known.code] ?? "UNAVAILABLE", what: known.detail, next: known.next }
  if (!(error instanceof Error)) return undefined
  const match = /^([A-Z][A-Z_]+): ([\s\S]*)$/.exec(error.message)
  if (!match) return undefined
  const rest = match[2]!
  const next = /\sNext step: ([\s\S]+)$/.exec(rest)?.[1]
  return {
    code: CODES[match[1]!] ?? (match[1] === "RATE_LIMITED" ? "RATE_LIMITED" : "UNAVAILABLE"),
    what: next === undefined ? rest : rest.slice(0, rest.length - next.length).trim(),
    next: next?.trim() ?? DEFAULT_NEXT[CODES[match[1]!] ?? ""] ?? DEFAULT_NEXT.UNAVAILABLE!,
  }
}

/** The contract refusal for a provider failure; null lets the register map an unknown error to UNAVAILABLE. */
export function refuse(error: unknown, action: string, next?: string): RegisterError | null {
  const found = refusalOf(error)
  if (found === undefined) return null
  const code = found.code as Parameters<typeof refusal>[0]
  return new RegisterError(refusal(code, `${action}: ${found.what}`, next ?? found.next ?? DEFAULT_NEXT[code] ?? DEFAULT_NEXT.UNAVAILABLE!))
}

/** Throw the contract refusal, or the original error so the register reports UNAVAILABLE with a redacted line. */
export function throwRefusal(error: unknown, action: string, next?: string): never {
  const mapped = refuse(error, action, next)
  if (mapped) throw mapped
  throw error
}
