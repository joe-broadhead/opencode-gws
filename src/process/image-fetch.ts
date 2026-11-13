import { GwsError, throwIfCancelled } from "../domain/errors.js"
import { IMAGE_MAX_BYTES, imageUrl, tooLarge, tokenHost } from "../domain/images.js"

/**
 * The one place the plugin fetches a picture over HTTPS itself, for `images.read`: gws reads Google's APIs only, and
 * a Drive thumbnail or a Docs picture is an address on Google's image servers. It is also the only code that puts an
 * account's token in an `Authorization` header, and only for a host `tokenHost` names.
 *
 * - The address is checked again here (`imageUrl`), whatever the caller checked.
 * - A redirect is never followed: any 3xx is `IMAGE_UNAVAILABLE`, so the token never reaches another address.
 * - No cookies, no referrer.
 * - The size is checked while the body streams: a `Content-Length` over the cap is refused before the body is read,
 *   and a body that passes the cap is cancelled there. A picture over the cap is refused, never cut short.
 */

export interface ImageFetchOptions {
  /** The account's access token. Refused for any host `tokenHost` does not name. */
  readonly token?: string
  readonly signal?: AbortSignal
  readonly maxBytes?: number
  /** The network seam. Tests pass a fake; the default is the global fetch. */
  readonly fetchImpl?: typeof fetch
}

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp"

export async function fetchImage(address: string, options: ImageFetchOptions = {}): Promise<Uint8Array> {
  const url = imageUrl(address)
  const max = options.maxBytes ?? IMAGE_MAX_BYTES
  if (options.token !== undefined && !tokenHost(url.hostname)) throw new GwsError("IMAGE_HOST_REFUSED", "the account's sign-in is never sent to this host")
  const headers: Record<string, string> = { accept: ACCEPT }
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`
  throwIfCancelled(options.signal)
  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(url.href, {
      method: "GET",
      headers,
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: options.signal,
    })
  } catch {
    throwIfCancelled(options.signal)
    throw new GwsError("IMAGE_UNAVAILABLE", "the picture's host could not be reached")
  }
  const discard = () => response.body?.cancel().catch(() => undefined)
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await discard()
    throw new GwsError("IMAGE_UNAVAILABLE", "the picture's host answered with a redirect, which is never followed")
  }
  if (response.status !== 200) {
    await discard()
    throw new GwsError("IMAGE_UNAVAILABLE", `the picture's host answered with HTTP ${response.status}`)
  }
  const declared = Number(response.headers.get("content-length") ?? Number.NaN)
  if (Number.isFinite(declared) && declared > max) {
    await discard()
    throw tooLarge()
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      throwIfCancelled(options.signal)
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) throw tooLarge()
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throwIfCancelled(options.signal)
    if (GwsError.from(error)) throw error
    throw new GwsError("IMAGE_UNAVAILABLE", "the picture's host stopped answering")
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}
