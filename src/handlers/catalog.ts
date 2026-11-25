import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { catalog } from "../provider/domain/manifest.js"
import type { Runtime } from "../provider/index.js"
import { CATALOG_INPUT, CATALOG_OUTPUT } from "./schemas.js"

/** `catalog`: the local gws command manifest. No Google call and no account. */
export function catalogHandler(runtime: Runtime): MethodHandler {
  return {
    description: "Search the local gws command manifest for services, methods and helpers by words from their ids.",
    input: CATALOG_INPUT,
    output: CATALOG_OUTPUT,
    async run(input) {
      return catalog(input as Parameters<typeof catalog>[0], runtime.visibleServices())
    },
  }
}
