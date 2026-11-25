import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { resolvePackagedBinary } from "../../src/provider/process/binary.js"
import { readNativeManifest } from "../../src/provider/process/install.js"

const root = join(import.meta.dirname, "..", "..")

describe("packaged native release manifest", () => {
  it("pins v0.0.0 and the upstream gws 0.22.5, so resolution reaches the download step", async () => {
    const manifest = await readNativeManifest(root)
    expect(manifest?.tag).toBe("v0.0.0")
    expect(manifest?.repository).toBe("we-the-rebel-alliance/gws-plugin")
    expect(manifest?.modules.gws?.["linux-x64-gnu"]?.executable.sha256).toBe("ab59c4bab4e7848740ba8cc3ef186152dab90121c45835b49bd1bf2a5c259b86")
    const cache = mkdtempSync(join(tmpdir(), "gws-native-manifest-"))
    try {
      await expect(resolvePackagedBinary({ cacheRoot: cache }, { os: "linux", cpu: "x64", glibc: true })).rejects.toThrow(/gws is not installed yet/)
    } finally {
      rmSync(cache, { recursive: true, force: true })
    }
  })
})
