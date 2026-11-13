import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Rpc } from "@opencode/plugin/rpc"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { account } from "../support/config.js"
import { ACCOUNT, type Harness, startHost } from "./harness.js"
import { packageJson } from "./package.js"

/**
 * images.read on a real host: on the RPC named after the package, beside calendar.today, as Jelly calls it with
 * `{ url }`. A Drive link is read through the fake gws; nothing reaches the network.
 */

const open = {}
const JellyRpc = Rpc.define({
  id: packageJson.name as string,
  methods: { "images.read": { input: open, output: open, errors: { failed: open } } },
  events: {},
})
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const LINK = "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view"

async function call(host: Harness, input: unknown): Promise<Record<string, any>> {
  try {
    return { value: await (host.opencode.rpc(JellyRpc) as unknown as Record<string, (input: unknown, options: unknown) => Promise<unknown>>)["images.read"]!(input, { location: host.location }) }
  } catch (error) {
    const e = error as Record<string, any>
    return { type: e.type ?? e._tag, code: e.data?.code, message: String(e.message ?? e) }
  }
}

const scratch = mkdtempSync(join(tmpdir(), "opencode-gws-images-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
afterEach(() => {
  delete process.env["FAKE_GWS_RESPONSES"]
  delete process.env["FAKE_GWS_OUTPUT_FILE"]
})

describe("images.read with a signed-in account", () => {
  let host: Harness
  beforeAll(async () => {
    host = await startHost({ options: { accounts: { [ACCOUNT]: account({ services: ["drive"] }) } } })
  })
  afterAll(async () => {
    await host?.close()
  })

  it("answers a Drive picture, read through the plugin's own read path, in Jelly's shape", async () => {
    const body = join(scratch, "picture")
    writeFileSync(body, PNG)
    process.env["FAKE_GWS_OUTPUT_FILE"] = body
    process.env["FAKE_GWS_RESPONSES"] = JSON.stringify({ "drive.files.get": { mimeType: "image/png", size: String(PNG.byteLength) } })
    expect((await call(host, { url: LINK })).value).toEqual({ mime: "image/png", base64: PNG.toString("base64") })
    expect(host.invocations().map((argv) => argv.slice(0, 3).join("."))).toEqual(["drive.files.get", "drive.files.get"])
  })

  it("refuses an address off its hosts as the declared error, and fetches nothing", async () => {
    const result = await call(host, { url: "https://evil.example/a.png" })
    expect(result).toMatchObject({ type: "failed", code: "IMAGE_HOST_REFUSED" })
    expect(result.message).not.toContain("evil.example")
  })
})
