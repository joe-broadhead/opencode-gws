import { describe, expect, it } from "vitest"
import { assertManifest, manifest } from "../../src/manifest.js"

describe("package manifest", () => {
  it("is the contract-checked capabilities value", () => {
    expect(manifest.plugin.name).toBe("gws")
    expect(manifest.methods.status.class).toBe("read")
  })

  it("refuses an invalid capabilities value with OPTIONS_INVALID", () => {
    expect(() => assertManifest({ version: 1 })).toThrow(/^OPTIONS_INVALID: /)
  })
})
