#!/usr/bin/env node
/**
 * `npm run test:pack`: pack the plugin the way a release does, install the tarball with no dependency, and load the
 * installed copy in the real OpenCode 2.4.1 host through the contract's host harness. With `OPENCODE_BIN_2_4_1` set, it
 * also starts that stock CLI and checks the plugin becomes active and answers `status` over RPC.
 *
 * The tarball carries no gws binary and no runtime dependency; the plugin downloads its pinned executable on first use.
 */
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const MAIN = "@we-the-rebel-alliance/gws-plugin"
const PLUGIN_ID = "gws"
const HOST_RANGE = ">=2.4.1 <2.5.0"
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"]

function check(condition, message) {
  if (!condition) throw new Error(`pack smoke: ${message}`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status}):\n${result.stderr}${result.stdout}`)
  return result.stdout
}

function packageJson(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
}

function isolatedEnv(root, extra = {}) {
  const home = join(root, "home")
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: join(root, "tmp"),
    LANG: "en_US.UTF-8",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_FREE_MODELS: "1",
    ...extra,
  }
  for (const dir of [env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME, env.TMPDIR]) mkdirSync(dir, { recursive: true })
  return env
}

function pack(destination) {
  const [result] = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination, ROOT]))
  return join(destination, result.filename)
}

function checkTarball(tarball, version) {
  const listing = run("tar", ["-tzf", tarball])
    .split("\n")
    .filter(Boolean)
    .map((path) => path.replace(/^package\//, ""))
  const required = ["package.json", "dist/index.js", "README.md", "LICENSE", "manifest/generated.json", "manifest/native.json", "NOTICE", "licenses/gws/LICENSE", "licenses/gws/NOTICE", "skills/gws/SKILL.md", "skills/gws-recipes/SKILL.md"]
  for (const path of required) check(listing.includes(path), `the tarball lacks ${path}`)
  const notice = run("tar", ["-xOzf", tarball, "package/NOTICE"])
  check(notice.includes("Copyright Eemeli Aro <eemeli@gmail.com>") && notice.includes("ISC License"), "NOTICE lacks the bundled yaml ISC notice")
  const gwsNotice = run("tar", ["-xOzf", tarball, "package/licenses/gws/NOTICE"])
  check(gwsNotice.includes("manifest/native.json"), "licenses/gws/NOTICE does not name the packaged manifest/native.json")
  check(!listing.some((path) => /(^|\/)gws$/.test(path)), "the tarball contains a gws binary")
  check(!listing.some((path) => /\.d\.[cm]?ts$/.test(path)), "the tarball contains type declarations")
  check(!listing.some((path) => path.startsWith("views/")), "the tarball contains a legacy view")
  const pkg = packageJson(ROOT)
  check(pkg.version === version, "the packed version is not package.json's")
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundledDependencies"]) check(pkg[field] === undefined, `the package declares ${field}`)
  for (const script of INSTALL_SCRIPTS) check(pkg.scripts?.[script] === undefined, `the package declares a ${script} lifecycle script`)
  console.log(`ok tarball: ${listing.length} files, ${statSync(tarball).size} bytes`)
}

function install(project, tarball) {
  mkdirSync(project)
  writeFileSync(join(project, "package.json"), `${JSON.stringify({ name: "pack-smoke", private: true, type: "module" })}\n`)
  run("npm", ["install", "--prefix", project, "--ignore-scripts", "--no-audit", "--no-fund", tarball])
  const installed = join(project, "node_modules", MAIN)
  const sdk = join(ROOT, "node_modules", "@opencode", "plugin")
  mkdirSync(join(project, "node_modules", "@opencode"), { recursive: true })
  symlinkSync(sdk, join(project, "node_modules", "@opencode", "plugin"), "dir")
  return installed
}

async function kitHostLoad(installed, version) {
  const { createHost } = await import("@we-the-rebel-alliance/plugin-contract/kit")
  const runHost = await createHost({
    directory: installed,
    version: "2.4.1",
    pluginId: PLUGIN_ID,
    options: { accounts: { work: {}, personal: {} }, audit: { enabled: false } },
  })
  try {
    if (runHost.refusal !== undefined) throw new Error(`the plugin refused 2.4.1: ${runHost.refusal}`)
    if (runHost.failure !== undefined) throw new Error(`the plugin does not load: ${runHost.failure}`)
    check(runHost.definition?.id === PLUGIN_ID, "the installed package's id is not gws")
    check(runHost.namespace?.name === PLUGIN_ID, "the tool namespace is not gws")
    check(runHost.tools.length === 20, `the installed package registers ${runHost.tools.length} tools, not 20`)
    check(runHost.rpc?.id === PLUGIN_ID, `the RPC id is ${runHost.rpc?.id}, not gws`)
    const status = await runHost.call("status", {})
    check(status.ok, `status over RPC failed: ${status.ok ? "" : status.message}`)
    const answer = status.output
    check(answer?.name === PLUGIN_ID && answer?.version === version, "status does not name gws and its version")
    check(answer?.host?.range === HOST_RANGE, "status does not carry the host range")
    check(Array.isArray(answer?.accounts) && answer.accounts.length === 2, "status does not list two accounts")
    const missing = await runHost.call("events_list", {})
    check(!missing.ok && missing.code === "ACCOUNT_REQUIRED", `events_list without an account answered ${missing.ok ? "a page" : missing.code}`)
    const unknown = await runHost.call("events_list", { account: "nobodyhere" })
    check(!unknown.ok && unknown.code === "ACCOUNT_UNKNOWN", `events_list with an unknown alias answered ${unknown.ok ? "a page" : unknown.code}`)
    console.log("ok contract host harness 2.4.1: 20 tools, one RPC id, status and two-account refusals")
  } finally {
    await runHost.close()
  }
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

async function poll(read, done, what, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await read()
      if (done(last)) return last
    } catch (error) {
      last = error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`pack smoke: timed out waiting for ${what}; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}

async function stockLoad(binary, installed, version, root) {
  const reported = run(binary, ["--version"]).trim()
  check(/2\.4\.1$/.test(reported), `${binary} reports ${reported}, not 2.4.1`)
  const project = join(root, "project")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "opencode.json"), JSON.stringify({ plugins: [{ package: installed, options: { accounts: { work: {}, personal: {} }, audit: { enabled: false } } }] }))
  const port = await freePort()
  const password = randomBytes(24).toString("hex")
  const env = isolatedEnv(root, { OPENCODE_PASSWORD: password, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" })
  const server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "warn"], { cwd: project, env, detached: true, stdio: ["ignore", "ignore", "pipe"] })
  let log = ""
  server.stderr.on("data", (chunk) => (log = (log + chunk).slice(-6000)))
  const stop = (signal) => {
    try {
      process.kill(-server.pid, signal)
    } catch {
      // already gone
    }
  }
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const api = async (method, path, body) => {
    const url = new URL(path, `http://127.0.0.1:${port}`)
    url.searchParams.set("location[directory]", project)
    const response = await fetch(url, { method, headers: { authorization, "content-type": "application/json" }, body: body && JSON.stringify(body) })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 400)}`)
    return JSON.parse(text)
  }
  try {
    const entry = await poll(
      async () => (await api("GET", "/api/plugin")).data.find((plugin) => plugin.id === PLUGIN_ID),
      (plugin) => plugin?.state?.status !== undefined && plugin.state.status !== "loading",
      "the plugin to load",
    )
    check(entry?.state?.status === "active", `the stock host did not activate the plugin: ${JSON.stringify(entry?.state)}\n${log}`)
    const session = await api("POST", "/api/session", { agent: "build", title: "pack smoke" })
    const { output } = await api("POST", `/api/rpc/${PLUGIN_ID}/status`, { input: { sessionID: session.data.id, input: {} } })
    check(output?.name === PLUGIN_ID && output?.version === version, "the stock host's status does not name gws and its version")
    check(output?.accounts?.length === 2, "the stock host's status does not list two accounts")
    console.log(`ok stock OpenCode ${reported}: plugin active, status over RPC`)
  } finally {
    stop("SIGTERM")
    const timer = setTimeout(() => stop("SIGKILL"), 5000)
    await new Promise((resolveExit) => server.once("exit", resolveExit))
    clearTimeout(timer)
  }
}

async function main() {
  check(Number(process.versions.node.split(".")[0]) >= 24, `the embedded host needs Node >= 24 (running ${process.version})`)
  const version = packageJson(ROOT).version
  check(existsSync(join(ROOT, "dist", "index.js")), "dist/index.js is missing; run npm run bundle first")
  const root = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "gws-pack-")))
  try {
    mkdirSync(join(root, "tarballs"))
    const tarball = pack(join(root, "tarballs"))
    checkTarball(tarball, version)
    const installed = install(join(root, "project-install"), tarball)
    const main = packageJson(installed)
    check(main.version === version, "the installed copy's version differs")
    check(main.exports?.["./server"] === "./dist/index.js", "the installed package has no ./server export")
    await kitHostLoad(installed, version)
    const binary = process.env.OPENCODE_BIN_2_4_1
    if (binary) await stockLoad(binary, installed, version, join(root, "stock"))
    else console.log("skip stock OpenCode: set OPENCODE_BIN_2_4_1 to a stock 2.4.1 binary to run it")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

await main()
