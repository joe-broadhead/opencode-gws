// The release tarball ships NOTICE next to dist/index.js, which inlines third-party packages. This test builds
// src/index.ts with scripts/bundle.mjs's options, collects every package esbuild actually inlines, and requires
// NOTICE to carry that package's "## <name> <version> (<SPDX licence>)" heading and its verbatim LICENSE.
import { build } from "esbuild"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("../../", import.meta.url))
const PLUGIN = "@we-the-rebel-alliance/gws-plugin"

/** A package name from an esbuild input path, or undefined for the plugin's own sources. */
function packageOf(path: string): string | undefined {
  const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path)
  return match?.[1]
}

function keep(name: string | undefined): name is string {
  return name !== undefined && name !== PLUGIN && !name.startsWith("@opencode/")
}

interface BundledPackage {
  readonly name: string
  readonly version: string
  readonly licence: string
  readonly text: string
}

function licenceText(name: string): string {
  for (const file of ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]) {
    try {
      return readFileSync(join(root, "node_modules", name, file), "utf8")
    } catch {
      // Try the next conventional licence file name.
    }
  }
  throw new Error(`${name} has no licence file`)
}

/** Every package esbuild actually inlines into the bundle, with its version and verbatim licence. */
async function bundledPackages(): Promise<BundledPackage[]> {
  const result = await build({
    absWorkingDir: root,
    bundle: true,
    splitting: false,
    format: "esm",
    platform: "node",
    target: "es2022",
    external: ["@opencode/plugin", "@opencode/plugin/*"],
    legalComments: "inline",
    banner: { js: 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);' },
    logLevel: "silent",
    entryPoints: [join(root, "src", "index.ts")],
    metafile: true,
    write: false,
  })
  const found = new Set<string>()
  const inputs = Object.keys(result.metafile.inputs)
  for (const path of inputs) {
    const name = packageOf(path)
    if (keep(name)) found.add(name)
  }
  // A bundled dist can inline its own dependencies; plugin-contract's chunks carry the original module path in a
  // comment (`// node_modules/zod/v4/...`). Those packages are redistributed by this bundle too.
  for (const path of inputs) {
    if (!path.startsWith("node_modules/")) continue
    const text = readFileSync(join(root, path), "utf8")
    for (const match of text.matchAll(/\/\/\s*node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//g)) {
      if (keep(match[1])) found.add(match[1])
    }
  }
  return [...found].sort().map((name) => {
    const pkg = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")) as { name: string; version: string; license: string }
    return { name: pkg.name, version: pkg.version, licence: pkg.license, text: licenceText(name) }
  })
}

function heading(pkg: BundledPackage): string {
  return `## ${pkg.name} ${pkg.version} (${pkg.licence})`
}

/** The packages whose heading or verbatim licence text the NOTICE does not carry. */
function missingNoticeSections(notice: string, packages: readonly BundledPackage[]): string[] {
  return packages.filter((pkg) => !notice.includes(heading(pkg)) || !notice.includes(pkg.text)).map((pkg) => pkg.name)
}

describe("the bundled third-party notices", () => {
  it("names every bundled package and carries its verbatim licence", async () => {
    const packages = await bundledPackages()
    expect(packages.map((pkg) => pkg.name)).toEqual(expect.arrayContaining(["@we-the-rebel-alliance/plugin-contract", "yaml", "zod"]))
    const notice = readFileSync(join(root, "NOTICE"), "utf8")
    expect(missingNoticeSections(notice, packages)).toEqual([])
  })

  it("reports a missing heading or altered licence", async () => {
    const packages = await bundledPackages()
    const yaml = packages.find((pkg) => pkg.name === "yaml")
    expect(yaml).toBeDefined()
    const notice = readFileSync(join(root, "NOTICE"), "utf8")
    const withoutHeading = notice.replace(/^## yaml [^\n]*$/m, "## yaml")
    expect(missingNoticeSections(withoutHeading, [{ ...yaml!, version: yaml!.version }])).toEqual(["yaml"])
    const altered = notice.replace(yaml!.text, yaml!.text.replace("Permission", "Permission!"))
    expect(missingNoticeSections(altered, [yaml!])).toEqual(["yaml"])
  })
})
