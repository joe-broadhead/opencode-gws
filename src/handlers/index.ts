import type { HandlerTable } from "@we-the-rebel-alliance/plugin-contract/register"
import type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"
import type { CommitCategory } from "../provider/domain/types.js"
import type { Runtime } from "../provider/index.js"
import { calendarTodayHandler } from "./calendar-today.js"
import { catalogHandler } from "./catalog.js"
import { commitHandler } from "./commit.js"
import { eventsListHandler } from "./events-list.js"
import { imagesReadHandler } from "./images-read.js"
import { planHandler } from "./plan.js"
import { probeHandler } from "./probe.js"
import { readHandler } from "./read.js"
import { schemaHandler } from "./schema.js"
import { sheetsReadHandler } from "./sheets-read.js"
import { statusHandler } from "./status.js"
import type { StatusState } from "./state.js"

export type { StatusState } from "./state.js"
export { statusHandler } from "./status.js"

/** The six per-class commit tools (LD-6); each commits the one plan its category names. */
const COMMITS: readonly CommitCategory[] = ["write", "send", "share", "delete", "export", "admin"]

/** The one handler table the contract's `register` wires through every door. */
export function createHandlers(input: { readonly runtime: Runtime; readonly manifest: Manifest; readonly version: string; readonly state: StatusState }): HandlerTable {
  const { runtime, manifest, version, state } = input
  return {
    status: statusHandler({ manifest, version, state, runtimeStatus: () => runtime.status() }),
    catalog: catalogHandler(runtime),
    schema: schemaHandler(runtime),
    read: readHandler(runtime),
    plan: planHandler(runtime),
    events_list: eventsListHandler(runtime),
    calendar_today: calendarTodayHandler(runtime),
    images_read: imagesReadHandler(runtime),
    sheets_read: sheetsReadHandler(runtime),
    probe: probeHandler(() => runtime.status()),
    ...Object.fromEntries(COMMITS.map((category) => [category, commitHandler(runtime, category)])),
  } as HandlerTable
}
