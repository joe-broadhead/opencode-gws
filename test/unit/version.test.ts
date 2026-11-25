import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { manifest, packageVersion } from "../../src/manifest.js"
import { PLUGIN_ID, PLUGIN_VERSION } from "../../src/provider/domain/version.js"

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string
  capabilities: { plugin: { name: string; host: { opencode: string; tested: string[] } } }
}

describe("package identity", () => {
  it("keeps the plugin name, package version and host range equal to the manifest", () => {
    expect(PLUGIN_ID).toBe("gws")
    expect(manifest.plugin.name).toBe(PLUGIN_ID)
    expect(PLUGIN_VERSION).toBe(pkg.version)
    expect(packageVersion).toBe(pkg.version)
    expect(manifest.plugin.host).toEqual({ opencode: ">=2.4.1 <2.5.0", tested: ["2.4.1"] })
  })
})
