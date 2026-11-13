import type { EventsOwner } from "../../vendor/source-contract-dist/events.js"

/** The owner each source read found, per runtime and account, so `probe` can answer without reading content. */
const owners = new WeakMap<object, Map<string, EventsOwner>>()
const key = (source: string, account: string) => `${source}\u0000${account}`

export function rememberOwner(runtime: object, source: string, account: string, owner: EventsOwner): void {
  let map = owners.get(runtime)
  if (map === undefined) {
    map = new Map()
    owners.set(runtime, map)
  }
  map.set(key(source, account), owner)
}

/** The owner a page or probe names: the one a read found, or the account until then. */
export function pageOwner(runtime: object, source: string, account: string): EventsOwner {
  return owners.get(runtime)?.get(key(source, account)) ?? { id: account, label: account }
}
