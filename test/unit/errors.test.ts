import { describe, expect, it } from "vitest"
import { ErrorCode, GwsError, cancelledError, isErrorCode } from "../../src/provider/domain/errors.js"

describe("error code table", () => {
  it("gives every code a meaning and a next step written as sentences", () => {
    for (const [code, entry] of Object.entries(ErrorCode)) {
      expect(code).toMatch(/^[A-Z][A-Z_]+$/)
      for (const text of [entry.meaning, entry.next]) {
        expect(text, code).toMatch(/^(?:[A-Z]|gws\b).*\.$/s)
        expect(text, code).not.toMatch(/\bTODO|WS-[A-Z]|reviewed package/i)
      }
    }
  })

  it("recognizes only its own codes", () => {
    expect(isErrorCode("AUTH_REQUIRED")).toBe(true)
    expect(isErrorCode("NOT_A_CODE")).toBe(false)
  })
})

describe("GwsError", () => {
  it("reads CODE: What happened. Next step: What to do.", () => {
    const error = new GwsError("PLAN_EXPIRED", "create a new plan")
    expect(error.message).toBe(`PLAN_EXPIRED: Create a new plan. Next step: ${ErrorCode.PLAN_EXPIRED.next}`)
    expect(error).toMatchObject({ code: "PLAN_EXPIRED", next: ErrorCode.PLAN_EXPIRED.next })
    expect(error.enableUrl).toBeUndefined()
    expect(String(error)).toMatch(/^Error: PLAN_EXPIRED: /)
  })

  it("keeps a message that ends a sentence, and takes a specific next step and enable link", () => {
    const error = new GwsError("API_DISABLED", "Gmail API is disabled.", { next: "Enable it.", enableUrl: "https://console.cloud.google.com/x" })
    expect(error.message).toBe("API_DISABLED: Gmail API is disabled. Next step: Enable it.")
    expect(error).toMatchObject({ code: "API_DISABLED", next: "Enable it.", enableUrl: "https://console.cloud.google.com/x" })
  })

  it("reads an Error that starts with a code, keeping a stated next step or adding the table's", () => {
    const stated = GwsError.from(new Error("AUTH_REQUIRED: 'work' is not signed in. Next step: Sign in with /connect"))
    expect(stated).toMatchObject({ code: "AUTH_REQUIRED", next: "Sign in with /connect", message: "AUTH_REQUIRED: 'work' is not signed in. Next step: Sign in with /connect." })
    const bare = GwsError.from(new Error("BINARY_TRUST_FAILED: not a regular file: /x"))
    expect(bare).toMatchObject({ code: "BINARY_TRUST_FAILED", next: ErrorCode.BINARY_TRUST_FAILED.next })
  })

  it("leaves an error with no code alone, and keeps its own class", () => {
    expect(GwsError.from(new Error("boom"))).toBeUndefined()
    expect(GwsError.from({ _tag: "E", message: "AUTH_REQUIRED: x" })).toBeUndefined()
  })

  it("makes a cancellation with its own next step", () => {
    expect(cancelledError()).toMatchObject({ code: "CANCELLED" })
    expect(cancelledError().message).toMatch(/^CANCELLED: .*Next step: /)
  })
})
