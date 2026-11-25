#!/usr/bin/env node
/**
 * Build the one file the host loads, `dist/index.js`: a self-contained esbuild bundle with only Node built-ins and
 * `@opencode/plugin` left external. No chunks, no relative imports, no declarations and no runtime dependencies.
 *
 * Modules that locate package files from `import.meta.url` (the manifest and the generated command catalog) count
 * directories from their source location. The `source-layout` plugin rewrites each such URL to the file's path under
 * `dist/`, so `../package.json` and `../../../manifest/generated.json` still reach the package root after bundling.
 *
 * The plugin version is read from `package.json` where it is used; nothing repeats it.
 */
import { build } from "esbuild"
import { dirname, join, relative, sep } from "node:path"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SRC = join(ROOT, "src")
const DIST = join(ROOT, "dist")

const sourceLayout = {
  name: "source-layout",
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, (args) => {
      if (!args.path.startsWith(SRC + sep)) return undefined
      const source = readFileSync(args.path, "utf8")
      if (!source.includes("import.meta.url")) return undefined
      const emitted = `./${relative(SRC, args.path).split(sep).join("/").replace(/\.ts$/, ".js")}`
      return { contents: source.replaceAll("import.meta.url", `new URL(${JSON.stringify(emitted)}, import.meta.url).href`), loader: "ts" }
    })
  },
}

await build({
  absWorkingDir: ROOT,
  bundle: true,
  splitting: false,
  format: "esm",
  platform: "node",
  target: "es2022",
  external: ["@opencode/plugin", "@opencode/plugin/*"],
  legalComments: "inline",
  logLevel: "warning",
  entryPoints: [join(SRC, "index.ts")],
  outfile: join(DIST, "index.js"),
  plugins: [sourceLayout],
})

console.log("built dist/index.js")
