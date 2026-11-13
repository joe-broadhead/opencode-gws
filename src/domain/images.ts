import { GwsError } from "./errors.js"
import type { PluginConfig } from "./types.js"

/**
 * `images.read`, the read Jelly makes to draw a Google picture in an agent's UI, as pure logic: which addresses it
 * takes, which hosts may ever see the account's token, what the bytes are, and which account reads them.
 *
 * Jelly's contract (hey-jelly `protocol/contracts/src/agent-ui/routes.ts` `AgentUiImageReadSchema`): the answer is a
 * PNG, JPEG, GIF or WebP whose first bytes say so, at most 1 MB, never SVG.
 */

/** The hosts the declaration names (`jelly.imageHosts`): a leading dot is a suffix. */
export const IMAGE_HOSTS = [".googleusercontent.com", "drive.google.com"] as const
/** Jelly's cap on one picture (`AGENT_UI_IMAGE_MAX_BYTES`). */
export const IMAGE_MAX_BYTES = 1024 * 1024
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const
export type ImageMime = (typeof IMAGE_MIMES)[number]
/** The longest address taken. */
export const IMAGE_URL_MAX = 2048

const SUFFIX = ".googleusercontent.com"
const DRIVE = "drive.google.com"
/**
 * The only hosts the account's token is ever sent to: Google's own image servers, which answer Drive thumbnails and
 * Docs and Slides pictures. Other `*.googleusercontent.com` names can be anyone's (Apps Script pages, a Compute Engine
 * machine's reverse DNS), so they are fetched without credentials or not at all.
 */
const TOKEN_HOST = /^lh[3-7](?:-[a-z0-9]+)*\.googleusercontent\.com$/
/** A Drive file id. */
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/

function refused(detail: string): GwsError {
  return new GwsError("IMAGE_HOST_REFUSED", detail)
}

/**
 * The address, when it is one `images.read` takes: https, on `drive.google.com` or a name under
 * `googleusercontent.com`, with no user name, password or port, and no IP address. Anything else is
 * `IMAGE_HOST_REFUSED`. The plugin checks this itself rather than trusting the caller's check.
 */
export function imageUrl(raw: unknown): URL {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > IMAGE_URL_MAX) throw refused(`the picture's address is not a string of 1 to ${IMAGE_URL_MAX} characters`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw refused("the picture's address is not a URL")
  }
  if (url.protocol !== "https:") throw refused("the picture's address is not https")
  if (url.username !== "" || url.password !== "") throw refused("the picture's address carries a user name or password")
  if (url.port !== "") throw refused("the picture's address names a port")
  const host = url.hostname
  if (host.startsWith("[") || /^[0-9.]+$/.test(host)) throw refused("the picture's address is an IP address")
  if (!allowedHost(host)) throw refused("the picture's host is not drive.google.com or under googleusercontent.com")
  return url
}

/** Exactly `drive.google.com`, or a name of non-empty labels ending in `.googleusercontent.com`. */
export function allowedHost(host: string): boolean {
  if (host === DRIVE) return true
  if (!host.endsWith(SUFFIX) || host.length === SUFFIX.length) return false
  return host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
}

/** Whether the account's token may be sent to this host. */
export function tokenHost(host: string): boolean {
  return TOKEN_HOST.test(host)
}

/** Whether the address is a Drive link, whose file the plugin reads through gws rather than fetching the link. */
export function isDriveLink(url: URL): boolean {
  return url.hostname === DRIVE
}

/**
 * The file id of a Drive link: `/file/d/<id>/…`, `/open?id=<id>`, `/uc?id=<id>` or `/thumbnail?id=<id>`. Anything
 * else (a folder, a search, no id) is `IMAGE_HOST_REFUSED`.
 */
export function driveFileId(url: URL): string {
  const path = /^\/file\/d\/([^/]+)(?:\/[^/]*)?$/.exec(url.pathname)
  const id = path ? path[1] : ["/open", "/uc", "/thumbnail"].includes(url.pathname) ? url.searchParams.get("id") : undefined
  if (typeof id !== "string" || !FILE_ID.test(id)) throw refused("the Drive link names no file")
  return id
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const starts = (bytes: Uint8Array, head: readonly number[], at = 0) => bytes.length >= at + head.length && head.every((byte, index) => bytes[at + index] === byte)
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0))
/** `RIFF`, then `WEBP` at byte 8. */
const RIFF = [0x52, 0x49, 0x46, 0x46]
const WEBP = [0x57, 0x45, 0x42, 0x50]

/**
 * What the bytes are, from their first bytes only, never from a `Content-Type` or Drive's `mimeType`: PNG, JPEG,
 * GIF (87a or 89a) or WebP (`RIFF` then `WEBP`). Anything else, SVG included, is undefined.
 */
export function sniffImage(bytes: Uint8Array): ImageMime | undefined {
  if (starts(bytes, PNG)) return "image/png"
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (starts(bytes, ascii("GIF87a")) || starts(bytes, ascii("GIF89a"))) return "image/gif"
  if (starts(bytes, RIFF) && starts(bytes, WEBP, 8)) return "image/webp"
  return undefined
}

/** The picture as Jelly takes it, or `IMAGE_TYPE_REFUSED` / `IMAGE_TOO_LARGE`. */
export function imageAnswer(bytes: Uint8Array): { mime: ImageMime; base64: string } {
  if (bytes.byteLength > IMAGE_MAX_BYTES) throw tooLarge()
  const mime = sniffImage(bytes)
  if (mime === undefined) throw new GwsError("IMAGE_TYPE_REFUSED", "the picture is not a PNG, JPEG, GIF or WebP")
  return { mime, base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64") }
}

export function tooLarge(): GwsError {
  return new GwsError("IMAGE_TOO_LARGE", `the picture is over ${IMAGE_MAX_BYTES / (1024 * 1024)} MB`)
}

/** How long an address Google returned is remembered, and how many are. */
export const SOURCE_TTL_MS = 60 * 60 * 1000
export const SOURCE_MAX = 1000
const WALK_MAX = 20_000

/**
 * The picture addresses Google returned to each account in this process, from the answers of its reads: an address
 * on the image hosts, kept in memory only (never bytes, never on disk), for an hour, at most SOURCE_MAX, the least
 * recently seen dropped first. It decides which account reads a picture, and whether the account's token may go to
 * it at all.
 */
export class ImageSources {
  private readonly seen = new Map<string, { accounts: Set<string>; at: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Remember every picture address in a read's answer as returned to `account`. */
  record(account: string, data: unknown): void {
    let budget = WALK_MAX
    const walk = (value: unknown, depth: number): void => {
      if (budget-- <= 0 || depth > 32) return
      if (typeof value === "string") {
        if (value.startsWith("https://") && value.length <= IMAGE_URL_MAX) this.add(account, value)
      } else if (Array.isArray(value)) for (const item of value) walk(item, depth + 1)
      else if (value !== null && typeof value === "object") for (const item of Object.values(value)) walk(item, depth + 1)
    }
    walk(data, 0)
  }

  /** The accounts Google returned this address to, within the last hour. */
  accounts(url: URL): string[] {
    const key = url.href
    const entry = this.seen.get(key)
    if (!entry) return []
    if (this.now() - entry.at > SOURCE_TTL_MS) {
      this.seen.delete(key)
      return []
    }
    return [...entry.accounts]
  }

  get size(): number {
    return this.seen.size
  }

  private add(account: string, raw: string): void {
    let key: string
    try {
      key = imageUrl(raw).href
    } catch {
      return
    }
    const entry = this.seen.get(key)
    const accounts = entry && this.now() - entry.at <= SOURCE_TTL_MS ? entry.accounts : new Set<string>()
    accounts.add(account)
    this.seen.delete(key)
    this.seen.set(key, { accounts, at: this.now() })
    while (this.seen.size > SOURCE_MAX) this.seen.delete(this.seen.keys().next().value!)
  }
}

/**
 * The account that reads a picture. Among the accounts Google returned the address to (when it returned it to any),
 * or else among the accounts that enable Drive: the only one, or else the `default` account when it is one of them.
 * Anything else is `IMAGE_ACCOUNT_AMBIGUOUS`: the plugin never tries each account in turn.
 */
export function imageAccount(config: Pick<PluginConfig, "accounts">, returnedTo: readonly string[]): string {
  const configured = (alias: string) => config.accounts[alias] !== undefined
  const known = returnedTo.filter(configured)
  const candidates = known.length > 0 ? known : Object.entries(config.accounts).filter(([, profile]) => profile.enabledServices.includes("drive")).map(([alias]) => alias)
  if (candidates.length === 1) return candidates[0]!
  if (candidates.includes("default")) return "default"
  if (candidates.length === 0)
    throw new GwsError("IMAGE_ACCOUNT_AMBIGUOUS", "no configured account enables drive", {
      next: "Add drive to an account's enabledServices, or remove accounts so the default account enables it.",
    })
  throw new GwsError("IMAGE_ACCOUNT_AMBIGUOUS", `${candidates.length} accounts could read the picture and none is the default account`)
}
