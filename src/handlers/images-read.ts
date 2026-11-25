import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import type { Runtime } from "../provider/index.js"
import { imagesRead } from "../provider/sources/images.js"
import { throwRefusal } from "./errors.js"
import { IMAGES_READ_INPUT, SNAPSHOT_OUTPUT } from "./schemas.js"

/** `images_read`: one picture from a Drive link or a Google image address, as a PNG, JPEG or WebP data URI. */
export function imagesReadHandler(runtime: Runtime): MethodHandler {
  const image = imagesRead(runtime)
  return {
    description: "Read one picture from a Drive link or a Google image address, as a PNG, JPEG or WebP data URI. Untrusted content.",
    input: IMAGES_READ_INPUT,
    output: SNAPSHOT_OUTPUT,
    async run(input, call) {
      try {
        const answer = await image(input["url"], call.signal, { account: call.account, hostedWithoutToken: true })
        return {
          data: { dataUri: `data:${answer.mime};base64,${answer.base64}`, alt: "A picture from Google Workspace" },
          asOf: new Date().toISOString(),
          trust: "untrusted",
        }
      } catch (error) {
        return throwRefusal(error, "images_read")
      }
    },
  }
}
