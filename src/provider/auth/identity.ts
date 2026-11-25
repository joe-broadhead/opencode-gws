/**
 * The signed-in Google account, from the `id_token` Google's token endpoint returns when `openid` is granted: its
 * verified email address and, for a Workspace account, its hosted domain (`hd`). The plugin reads the token straight
 * from the token endpoint over TLS, so, as OpenID Connect Core 3.1.3.7 allows, the TLS check of the issuer stands in
 * for the signature check. The claims it still requires are checked first: `iss` is Google's, `aud` is the client
 * the sign-in used, and `exp` has not passed. Nothing here authorizes anything: status reports it, so a host can tell
 * which account is signed in.
 *
 * A malformed token, one whose claims do not check out, or one without a verified email or a domain gives no
 * identity rather than an error: a sign-in still works without it.
 */

export interface SignInIdentity {
  /** The account's email address, only when Google says it is verified. */
  email?: string
  /** The Workspace domain the account belongs to (`hd`); absent for a consumer account. */
  domain?: string
}

/** The issuers Google's ID tokens name (OpenID Connect discovery lists the first; Google also documents the second). */
const GOOGLE_ISSUERS: readonly unknown[] = ["https://accounts.google.com", "accounts.google.com"]

/** What the token must have been issued for. */
export interface IdTokenExpectation {
  /** The OAuth client ID the sign-in or refresh used: the token's `aud`. */
  clientId: string
  /** The current time, in milliseconds since the epoch; the token's `exp` must be after it. */
  now: number
}

/** At most this long: a Google id_token is about 1 KB. */
const MAX_TOKEN_LENGTH = 16 * 1024
const SEGMENT = /^[A-Za-z0-9_-]+$/
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}$/
const DOMAIN = /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u

/** The identity in an id_token, or undefined when it holds none this plugin can trust. */
export function idTokenIdentity(token: unknown, expected: IdTokenExpectation): SignInIdentity | undefined {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return undefined
  const parts = token.split(".")
  if (parts.length !== 3 || !parts.every((part) => SEGMENT.test(part))) return undefined
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"))
  } catch {
    return undefined
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return undefined
  const record = claims as Record<string, unknown>
  if (!issuedFor(record, expected)) return undefined
  const email = record["email_verified"] === true && typeof record["email"] === "string" && EMAIL.test(record["email"]) ? record["email"].toLowerCase() : undefined
  const domain = typeof record["hd"] === "string" && DOMAIN.test(record["hd"]) ? record["hd"].toLowerCase() : undefined
  if (email === undefined && domain === undefined) return undefined
  return { ...(email === undefined ? {} : { email }), ...(domain === undefined ? {} : { domain }) }
}

/** OpenID Connect Core 3.1.3.7, steps 2, 3 and 9: Google issued it, for this client, and it has not expired. */
function issuedFor(claims: Record<string, unknown>, expected: IdTokenExpectation): boolean {
  if (!GOOGLE_ISSUERS.includes(claims["iss"])) return false
  const aud = claims["aud"]
  if (!expected.clientId || !(aud === expected.clientId || (Array.isArray(aud) && aud.includes(expected.clientId)))) return false
  const exp = claims["exp"]
  return typeof exp === "number" && Number.isFinite(exp) && exp * 1000 > expected.now
}
