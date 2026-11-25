import { resolveClient, type ClientChoice } from "./client.js"
import { readSignIn } from "./credential.js"
import { readAnswer, signInForm, signInScopes, type SignInForm } from "./form.js"
import { GOOGLE_METHOD_ID, authorizeGoogle, refreshGoogle, type GoogleAuthOptions, type GoogleOAuthAuthorization, type OAuthCredential } from "./google.js"
import { resolveRedirect } from "../domain/redirect.js"
import type { AccountProfile, OAuthClient, RedirectConfig } from "../domain/types.js"

/**
 * One account's Google sign-in method: the form, the browser flow with the client, access and scopes the answer chose,
 * and the token refresh. `registerAccounts` passes the integration id the alias gets; this module only builds the
 * method, so it needs no host.
 */
export interface GoogleIntegrationOptions {
  pluginClient?: OAuthClient
  redirect?: RedirectConfig
  /** The client of the account's current sign-in, so a re-sign-in can reuse a pasted one. */
  previous?: () => Promise<ClientChoice | undefined>
  auth?: GoogleAuthOptions
}

export interface GoogleIntegrationDefinition {
  integrationID: string
  name: string
  alias: string
  method: { id: string; type: "oauth"; label: string; form: SignInForm }
  authorize: (answer: Record<string, unknown>) => Promise<GoogleOAuthAuthorization>
  refresh: (credential: OAuthCredential) => Promise<OAuthCredential>
  label: (credential: OAuthCredential) => string | undefined
}

export function googleIntegration(
  alias: string,
  profile: AccountProfile,
  integrationID: string,
  options: GoogleIntegrationOptions = {},
): GoogleIntegrationDefinition {
  const configured = { account: profile.oauthClient, plugin: options.pluginClient }
  const name = "Google Workspace"
  return {
    integrationID,
    name,
    alias,
    method: {
      id: GOOGLE_METHOD_ID,
      type: "oauth",
      label: "Sign in with Google",
      form: signInForm(alias, profile, resolveClient(configured), options.redirect),
    },
    authorize: async (answer) => {
      const { pasted, access, redirect: entered } = readAnswer(answer)
      // Each field the host filled in wins over its option, which is only the field's default.
      const redirect = resolveRedirect({
        redirectUri: entered.redirectUri ?? options.redirect?.redirectUri,
        callbackPort: entered.callbackPort ?? options.redirect?.callbackPort,
      })
      const previous = pasted ? undefined : await options.previous?.()
      const client = resolveClient({ ...configured, pasted, previous })
      if (!client) {
        throw new Error(
          `AUTH_CLIENT_REQUIRED: No OAuth client is configured for ${alias}. Next step: Run /connect and choose ${name}, then enter your Desktop OAuth client ID and secret, or ask your administrator.`,
        )
      }
      return authorizeGoogle({ alias, client, access, scopes: signInScopes(profile, access), redirect, options: options.auth })
    },
    refresh: (credential) => refreshGoogle({ alias, name, credential, options: options.auth }),
    // The account's name in /connect: the verified email the sign-in returned, else the alias.
    label: (credential) => readSignIn(credential.metadata)?.email ?? alias,
  }
}
