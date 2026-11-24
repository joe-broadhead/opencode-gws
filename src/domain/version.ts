/** package.json `version`, set at build time by scripts/bundle.mjs and in tests by vitest.config.ts. */
declare const __PLUGIN_VERSION__: string
export const PLUGIN_VERSION = __PLUGIN_VERSION__
export const PLUGIN_ID = "google-workspace.gws"
/** The npm package name: every `events_list` page names it, and the cursor binding is keyed on the plugin's id. */
export const PACKAGE_NAME = "@we-the-rebel-alliance/gws-plugin"
