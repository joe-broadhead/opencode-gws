import { describe, expect, it } from "vitest"
import { idTokenIdentity as identityOf } from "../src/auth/identity.js"

/** An unsigned JWT-shaped token with these claims; the plugin reads it from Google's token endpoint over TLS. */
const rawToken = (claims: unknown, header: unknown = { alg: "RS256", typ: "JWT" }) =>
  [header, claims].map((part) => Buffer.from(typeof part === "string" ? part : JSON.stringify(part)).toString("base64url")).join(".") + ".c2lnbmF0dXJl"

const CLIENT = "123-abc.apps.googleusercontent.com"
const NOW = Date.parse("2026-11-12T12:00:00Z")
/** The claims that make a token Google's, for this client, and unexpired. */
const VALID = { iss: "https://accounts.google.com", aud: CLIENT, exp: NOW / 1000 + 3600 }
/** The identity in a token whose claims check out, unless the test sets them. */
const idTokenIdentity = (input: unknown) => identityOf(input, { clientId: CLIENT, now: NOW })
const token = (claims: unknown, header: unknown = { alg: "RS256", typ: "JWT" }) =>
  rawToken(typeof claims === "object" && claims !== null && !Array.isArray(claims) ? { ...VALID, ...claims } : claims, header)

describe("the signed-in identity from an id_token", () => {
  it("reads a verified email and the hosted domain, lower-cased", () => {
    expect(idTokenIdentity(token({ iss: "https://accounts.google.com", email: "Ada@Example.COM", email_verified: true, hd: "Example.com" }))).toEqual({
      email: "ada@example.com",
      domain: "example.com",
    })
  })

  it("gives a consumer account its email and no domain", () => {
    expect(idTokenIdentity(token({ email: "ada@gmail.com", email_verified: true }))).toEqual({ email: "ada@gmail.com" })
  })

  it("leaves out an email Google has not verified, and keeps the domain", () => {
    expect(idTokenIdentity(token({ email: "ada@example.com", email_verified: false, hd: "example.com" }))).toEqual({ domain: "example.com" })
    expect(idTokenIdentity(token({ email: "ada@example.com", email_verified: "true" }))).toBeUndefined()
    expect(idTokenIdentity(token({ email: "ada@example.com" }))).toBeUndefined()
  })

  it("gives no identity for a malformed token, never an error", () => {
    for (const malformed of [
      undefined,
      null,
      42,
      "",
      "not-a-jwt",
      "a.b",
      "a.b.c.d",
      "a..c",
      "a.b c.d",
      "a.!!!.c",
      token("not json"),
      token("[1,2]"),
      token("null"),
      token(123),
      token({ email: 42, email_verified: true, hd: ["example.com"] }),
      token({ email: "no-at-sign", email_verified: true }),
      token({ email: "two@@example.com", email_verified: true }),
      token({ email: "ada@example.com\n", email_verified: true }),
      token({ hd: "not a domain" }),
      token({ hd: "localhost" }),
      token({}),
      `${"a".repeat(20_000)}.${"b".repeat(10)}.c`,
    ]) {
      expect(() => idTokenIdentity(malformed), String(malformed).slice(0, 40)).not.toThrow()
      expect(idTokenIdentity(malformed), String(malformed).slice(0, 40)).toBeUndefined()
    }
  })

  it("gives no identity when the token is not Google's, not for this client, or expired", () => {
    const claims = { email: "ada@example.com", email_verified: true, hd: "example.com" }
    expect(idTokenIdentity(token(claims))).toEqual({ email: "ada@example.com", domain: "example.com" })
    expect(idTokenIdentity(token({ ...claims, iss: "accounts.google.com" }))).toEqual({ email: "ada@example.com", domain: "example.com" })
    expect(idTokenIdentity(token({ ...claims, aud: ["other.apps.googleusercontent.com", CLIENT] }))).toEqual({ email: "ada@example.com", domain: "example.com" })
    for (const [why, bad] of [
      ["another issuer", { iss: "https://evil.example.com" }],
      ["an issuer that only starts like Google's", { iss: "https://accounts.google.com.evil.example" }],
      ["no issuer", { iss: undefined }],
      ["another client", { aud: "other.apps.googleusercontent.com" }],
      ["no audience", { aud: undefined }],
      ["an audience list without this client", { aud: ["other.apps.googleusercontent.com"] }],
      ["expired", { exp: NOW / 1000 - 1 }],
      ["expiring now", { exp: NOW / 1000 }],
      ["no expiry", { exp: undefined }],
      ["an expiry that is not a number", { exp: String(NOW / 1000 + 3600) }],
    ] as const) {
      expect(idTokenIdentity(token({ ...claims, ...bad })), why).toBeUndefined()
    }
    expect(identityOf(token(claims), { clientId: "", now: NOW }), "no client to check against").toBeUndefined()
  })
})
