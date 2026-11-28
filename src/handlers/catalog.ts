import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { catalog } from "../provider/domain/manifest.js"
import { gmailMcpOperations } from "../provider/domain/mcp.js"
import type { Runtime } from "../provider/index.js"
import { CATALOG_INPUT, CATALOG_OUTPUT } from "./schemas.js"

/**
 * `catalog`: the local gws command manifest, with the Gmail operations Google's MCP server covers hidden for an
 * interactive account. A headless profile has no MCP sign-in, so its catalog keeps them.
 */
export function catalogHandler(runtime: Runtime): MethodHandler {
  return {
    description: "Search the local gws command manifest for services, methods and helpers by words from their ids.",
    input: CATALOG_INPUT,
    output: CATALOG_OUTPUT,
    async run(input, call) {
      const hidden = runtime.gmailOnMcp(call.account) ? new Set(gmailMcpOperations()) : undefined
      return catalog(input as Parameters<typeof catalog>[0], runtime.visibleServices(), hidden)
    },
  }
}
