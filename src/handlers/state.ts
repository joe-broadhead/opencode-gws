/** What `setup` gives status: the host version it ran on and the account registrations' problems. */
export interface StatusState {
  readonly hostVersion: string
  readonly accountProblems: readonly string[]
}
