/**
 * The plugin's access option. The contract's `access` module turns the level and the manifest's methods into rules;
 * this module only names the three levels the options schema offers.
 */
export const ACCESS_VALUES = ["all", "ask-changes", "read-only"] as const
export type Access = (typeof ACCESS_VALUES)[number]
