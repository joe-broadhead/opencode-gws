// Tests for the release kit: the CHANGELOG shape, the version and its tag, the pack stage's tarball check, and the
// Release upload that never deletes or replaces an asset. They run with Node's own runner and need only git:
//
//   node --test scripts/release-kit.test.mjs
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { changelogProblems, releaseNotes, shapeChangelog } from "./changelog.mjs"
import { publish } from "./publish-release.mjs"
import { NOREPLY_DOMAIN, serialise, tagFor, tagProblem, versionProblem } from "./release-commit.mjs"
import { namesTarball, readsTarball } from "./release-pack.mjs"

const SCRIPTS = fileURLToPath(new URL(".", import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), "release-kit-test-"))
after(() => rmSync(scratch, { recursive: true, force: true }))
let made = 0
const folder = () => {
  const dir = join(scratch, String(made++))
  mkdirSync(dir, { recursive: true })
  return dir
}

const PREAMBLE = "# Changelog\n\nAll notable changes to this project are documented here.\n"
const EARLIER = "## Earlier releases on npm\n\nThese versions were published to npm.\n\n### npm 0.0.10 - 2026-11-08\n\n#### Added\n\n- An npm feature.\n"
const V000 = "## [0.0.0] - 2026-11-10\n\n### Changed\n\n- Installed from GitHub.\n"
const V001 = "## [0.0.1] - 2026-11-12\n\n### Fixed\n\n- A config fix.\n"
const UNRELEASED = "## [Unreleased]\n\n### Fixed\n\n- A config fix.\n"
const doc = (...sections) => [PREAMBLE, ...sections].join("\n")

/** One GitHub release, then the npm history. */
const ONE = doc(V000, EARLIER)
/** Two GitHub releases, newest first, then the npm history. */
const TWO = doc(V001, V000, EARLIER)

describe("the CHANGELOG with one GitHub release", () => {
  test("is in the release shape for that version, and its notes are its section", () => {
    assert.deepEqual(changelogProblems(ONE, "0.0.0"), [])
    assert.equal(releaseNotes(ONE, "0.0.0"), V000.trim())
  })

  test("is refused for a version it has no heading for", () => {
    assert.deepEqual(changelogProblems(ONE, "0.0.1"), ["expected one ## [0.0.1] heading, found 0"])
    assert.throws(() => releaseNotes(ONE, "0.0.1"), /no "## \[0\.0\.1\]" heading/)
  })
})

describe("the CHANGELOG with two GitHub releases", () => {
  test("is in the release shape for the newest, and the notes stop at the next release", () => {
    assert.deepEqual(changelogProblems(TWO, "0.0.1"), [])
    assert.equal(releaseNotes(TWO, "0.0.1"), V001.trim())
    assert.equal(releaseNotes(TWO, "0.0.0"), V000.trim())
  })

  test("is refused for the older release, which is not the newest heading", () => {
    assert.deepEqual(changelogProblems(TWO, "0.0.0"), ["## [0.0.0] is not the newest release heading"])
  })

  test("is refused with the releases out of order, repeated or undated", () => {
    assert.match(changelogProblems(doc(V000, V001, EARLIER), "0.0.1").join("; "), /"## \[0\.0\.0\] - 2026-11-10" is above "## \[0\.0\.1\] - 2026-11-12"/)
    assert.match(changelogProblems(doc(V001, V001, V000), "0.0.1").join("; "), /expected one ## \[0\.0\.1\] heading, found 2/)
    assert.match(changelogProblems(doc("## [0.0.1]\n\n- A fix.\n", V000), "0.0.1").join("; "), /"## \[0\.0\.1\]" is not dated/)
    assert.match(changelogProblems(doc("## [0.0.1] - soon\n\n- A fix.\n", V000), "0.0.1").join("; "), /is not dated/)
  })

  test("is refused with the npm history above a release, or a heading the shape does not know", () => {
    assert.match(changelogProblems(doc(V001, EARLIER, V000), "0.0.1").join("; "), /"## Earlier releases on npm" must be the last section/)
    assert.match(changelogProblems(doc(V001, "## Notes\n\n- Something.\n", V000), "0.0.1").join("; "), /"## Notes" is not a heading the release shape knows/)
  })

  test("is refused when the release has no notes", () => {
    assert.match(changelogProblems(doc("## [0.0.1] - 2026-11-12\n", V000), "0.0.1").join("; "), /the ## \[0\.0\.1\] section has no notes/)
  })
})

describe("a leftover ## [Unreleased]", () => {
  test("is refused, and names the step that releases it", () => {
    const problems = changelogProblems(doc(UNRELEASED, V000, EARLIER), "0.0.1")
    assert.match(problems.join("; "), /an ## \[Unreleased\] section is still there: run node scripts\/changelog\.mjs release/)
    assert.match(problems.join("; "), /expected one ## \[0\.0\.1\] heading, found 0/)
    assert.match(changelogProblems(doc(UNRELEASED, V001, V000), "0.0.1").join("; "), /an ## \[Unreleased\] section is still there/)
  })
})

describe("shapeChangelog", () => {
  const release = (text, version = "0.0.1") => shapeChangelog(text, { version, date: "2026-11-12" })

  test("turns ## [Unreleased] into the dated release, above the earlier ones, and changes nothing else", () => {
    assert.equal(release(doc(UNRELEASED, V000, EARLIER)), TWO)
  })

  test("is idempotent: a released CHANGELOG comes back unchanged", () => {
    assert.equal(release(TWO), TWO)
    assert.equal(release(release(doc(UNRELEASED, V000, EARLIER))), TWO)
    assert.equal(release(ONE, "0.0.0"), ONE)
  })

  test("moves an ## [Unreleased] found below a release to the top", () => {
    assert.equal(release(doc(V000, UNRELEASED, EARLIER)), TWO)
  })

  test("ignores a ## line inside fenced code", () => {
    const fenced = "## [Unreleased]\n\n- A fix:\n\n```md\n## [9.9.9] - not a heading\n```\n"
    const shaped = release(doc(fenced, V000))
    assert.equal(shaped, doc(fenced.replace("## [Unreleased]", "## [0.0.1] - 2026-11-12"), V000))
    assert.deepEqual(changelogProblems(shaped, "0.0.1"), [])
    assert.match(releaseNotes(shaped, "0.0.1"), /## \[9\.9\.9\] - not a heading\n```$/)
  })

  test("refuses what it cannot shape, so nothing is written", () => {
    assert.throws(() => release(ONE), /no ## \[Unreleased\] section to release as 0\.0\.1/)
    assert.throws(() => release(doc(UNRELEASED, V001, V000)), /both ## \[Unreleased\] and a ## \[0\.0\.1\] heading/)
    assert.throws(() => release(doc(UNRELEASED, "## [0.0.2] - 2026-11-11\n\n- Later.\n", V000)), /"## \[0\.0\.2\] - 2026-11-11" is not older than 0\.0\.1/)
    assert.throws(() => release(doc("## [Unreleased]\n", V000)), /has no notes/)
    assert.throws(() => release(doc(UNRELEASED, UNRELEASED, V000)), /2 ## \[Unreleased\] sections/)
    assert.throws(() => release(doc(UNRELEASED, "## Notes\n\n- Something.\n")), /"## Notes" is not a heading/)
    assert.throws(() => shapeChangelog(ONE, { version: "0.0.1-rc.1", date: "2026-11-12" }), /is not x\.y\.z/)
    assert.throws(() => shapeChangelog(ONE, { version: "0.0.1", date: "12 Nov" }), /is not YYYY-MM-DD/)
  })
})

describe("the version and its tag", () => {
  test("the tag is exactly v<version>, for an x.y.z version", () => {
    assert.equal(tagFor("0.0.1"), "v0.0.1")
    assert.equal(tagProblem("v0.0.1", "0.0.1"), undefined)
    assert.equal(tagProblem("v1.20.3", "1.20.3"), undefined)
  })

  test("refuses a tag that differs from v<version>", () => {
    assert.equal(tagProblem("v0.0.0", "0.0.1"), "the tag is v0.0.0, and package.json's version 0.0.1 releases only as v0.0.1")
    for (const tag of ["0.0.1", "v0.0.1 ", "V0.0.1", "v0.0.10", "release-0.0.1"]) assert.match(tagProblem(tag, "0.0.1"), /releases only as v0\.0\.1/, tag)
  })

  test("refuses a version that is not x.y.z", () => {
    for (const version of ["0.0.1-rc.1", "0.0.1+build", "01.0.0", "0.0", "v0.0.1", "", undefined, 1]) {
      assert.match(versionProblem(version), /is not x\.y\.z/, String(version))
      assert.match(tagProblem(`v${version}`, version), /is not x\.y\.z/, String(version))
    }
  })
})

/** A git repository in a scratch folder, with no global or system config, committing as a noreply identity. */
function repository(files) {
  const dir = folder()
  const home = folder()
  writeFileSync(join(home, ".gitconfig"), "")
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" }
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" })
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`)
    return result.stdout.trim()
  }
  git("init", "-q", "-b", "master")
  git("config", "user.name", "kit-test")
  git("config", "user.email", `kit-test@${NOREPLY_DOMAIN}`)
  git("config", "commit.gpgsign", "false")
  git("config", "tag.gpgsign", "false")
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text)
  git("add", ".")
  git("commit", "-q", "-m", "chore: the source")
  const node = (script, ...args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd: dir, env, encoding: "utf8" })
  return { dir, git, node, head: git("rev-parse", "HEAD") }
}

describe("check-release-shape.mjs", () => {
  test("refuses a tag that is not v<package.json version>, and accepts the one that is", () => {
    const repo = repository({ "package.json": serialise({ name: "kit-test", version: "0.0.1" }), "CHANGELOG.md": TWO })
    repo.git("tag", "-a", "v0.0.2", "-m", "v0.0.2")
    repo.git("tag", "-a", "v0.0.1", "-m", "v0.0.1")
    writeFileSync(join(repo.dir, "..", "signers"), "")
    const signers = ["--verify", "git", "--allowed-signers", join(repo.dir, "..", "signers"), "--branch", "master"]

    const wrong = repo.node("check-release-shape.mjs", "--tag", "v0.0.2", ...signers)
    assert.equal(wrong.status, 1)
    assert.match(wrong.stdout, /FAIL the version: the tag is v0\.0\.2, and package\.json's version 0\.0\.1 releases only as v0\.0\.1/)

    const right = repo.node("check-release-shape.mjs", "--tag", "v0.0.1", ...signers)
    assert.match(right.stdout, /ok {3}the tag is v0\.0\.1, and the version is 0\.0\.1/)
    assert.doesNotMatch(right.stdout, /FAIL the version/)
  })
})

describe("release-commit.mjs", () => {
  const source = (version, changelog = TWO) => ({ "package.json": serialise({ name: "kit-test", version }), "CHANGELOG.md": changelog })
  const run = (repo) => repo.node("release-commit.mjs", "--ci-sha", repo.head, "--dry-run")

  test("refuses a version that is not x.y.z", () => {
    const repo = repository(source("0.0.1-rc.1"))
    assert.match(run(repo).stderr, /release-commit: package\.json version "0\.0\.1-rc\.1" is not x\.y\.z/)
  })

  test("refuses a tag that already exists", () => {
    const repo = repository(source("0.0.1"))
    repo.git("tag", "-a", "v0.0.1", "-m", "v0.0.1")
    assert.match(run(repo).stderr, /release-commit: tag v0\.0\.1 already exists/)
  })

  test("refuses a CHANGELOG that is not ready for the version, before anything is built", () => {
    const repo = repository(source("0.0.1", doc(UNRELEASED, V000, EARLIER)))
    const result = run(repo)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /release-commit: CHANGELOG\.md is not ready for v0\.0\.1: an ## \[Unreleased\] section is still there/)
    assert.match(run(repository(source("0.0.0"))).stderr, /CHANGELOG\.md is not ready for v0\.0\.0: ## \[0\.0\.0\] is not the newest release heading/)
  })

  test("takes the version from package.json, past every version check", () => {
    // The next refusal, a package with no build script, comes after the version, tag and CHANGELOG checks.
    assert.match(run(repository(source("0.0.1"))).stderr, /release-commit: package\.json has no "build" script/)
  })
})

describe("the pack stage's tarball", () => {
  test("is named only as a whole word", () => {
    for (const text of ["process.env.PACK_TARBALL", 'env["PACK_TARBALL"]', '"$PACK_TARBALL"', "${PACKED_DIR}/x.tgz", "const { PACKED_DIR } = process.env"]) {
      assert.equal(namesTarball(text), true, text)
    }
    for (const text of ["process.env.SLACK_PACK_TARBALL", "PACK_TARBALLS", "MY_PACKED_DIR", "PACKED_DIR_2", "pack_tarball"]) {
      assert.equal(namesTarball(text), false, text)
    }
  })

  test("is read by a pack test, not by a longer name or the kit's own files", () => {
    const root = folder()
    mkdirSync(join(root, "scripts"))
    mkdirSync(join(root, "test", "pack"), { recursive: true })
    writeFileSync(join(root, "scripts", "release-pack.mjs"), "env: { PACK_TARBALL: tarball, PACKED_DIR: dir }\n")
    writeFileSync(join(root, "scripts", "release-kit.test.mjs"), "namesTarball('process.env.PACK_TARBALL')\n")
    writeFileSync(join(root, "test", "pack", "pack.test.ts"), "const tarball = process.env.SLACK_PACK_TARBALL\n")
    assert.equal(readsTarball(root), false)
    writeFileSync(join(root, "test", "pack", "install.test.ts"), "const tarball = process.env.PACK_TARBALL\n")
    assert.equal(readsTarball(root), true)
  })
})

describe("publish-release.mjs", () => {
  test("never deletes or replaces an asset: a kit file with other contents stops the upload", () => {
    const dir = folder()
    writeFileSync(join(dir, "SHA256SUMS"), "sums\n")
    writeFileSync(join(dir, "kit-test-0.0.1.tgz"), "tarball\n")
    const calls = []
    const gh = (args) => {
      calls.push(args[1])
      if (args[1] === "view") return JSON.stringify({ isDraft: false, assets: [{ name: "SHA256SUMS" }, { name: "speech.bin" }] })
      if (args[1] === "download") writeFileSync(join(args[args.indexOf("--dir") + 1], "SHA256SUMS"), "other sums\n")
      return ""
    }
    assert.throws(() => publish({ tag: "v0.0.1", dir, notes: join(dir, "SHA256SUMS"), gh }), /SHA256SUMS is on the Release with other contents: nothing was uploaded/)
    assert.deepEqual(calls, ["view", "download"])
  })

  test("adds only the missing kit files, and leaves the assets it does not know alone", () => {
    const dir = folder()
    writeFileSync(join(dir, "SHA256SUMS"), "sums\n")
    writeFileSync(join(dir, "kit-test-0.0.1.tgz"), "tarball\n")
    const calls = []
    const gh = (args) => {
      calls.push(args)
      if (args[1] === "view") return JSON.stringify({ isDraft: false, assets: [{ name: "SHA256SUMS" }, { name: "speech.bin" }] })
      if (args[1] === "download") writeFileSync(join(args[args.indexOf("--dir") + 1], "SHA256SUMS"), "sums\n")
      return ""
    }
    const result = publish({ tag: "v0.0.1", dir, notes: join(dir, "SHA256SUMS"), gh })
    assert.deepEqual(result, { action: "uploaded", uploaded: ["kit-test-0.0.1.tgz"], unknown: ["speech.bin"] })
    assert.deepEqual(calls.map((args) => args[1]), ["view", "download", "upload"])
    assert.ok(calls.every((args) => !args.includes("delete") && !args.includes("--clobber")))
  })
})
