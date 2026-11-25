import type { AccessLevel } from "./types.js"

/**
 * What the provider knows about its accounts without OpenCode's help, for the `status` and `probe` handlers.
 * Never a token or a client secret: a reason is one redacted line.
 */
export interface AccountView {
  alias: string
  mode: "interactive" | "credentials_file" | "access_token"
  services: string[]
  /** Interactive: signed in and usable. Headless: its environment variable is set. */
  connected: boolean
  needsAuth?: true
  access?: AccessLevel
  grantedScopes?: string[]
  /** The signed-in account's verified email address, from the sign-in's id_token. */
  email?: string
  domain?: string
  integrationID?: string
  nextStep?: string
}

/** The provider's own status: versions, the binary and each account. */
export interface RuntimeStatus {
  auditDegraded: boolean
  version: string
  binary: { path: string; version: string; problem?: string }
  services: string[]
  accounts: AccountView[]
}
