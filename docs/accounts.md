# Accounts

Accounts are held by the **integration** mechanism: the plugin holds each account's OAuth grant in OpenCode's
credential store and passes only that account's access token to the `gws` child it runs.

<!-- generated:accounts -->
Accounts are held by the **integration** mechanism: the plugin holds the credentials.

| Field | Type | Required |
|---|---|---|
| `mode` | `interactive` \| `credentials_file` \| `access_token` | no |
| `enabledServices` | array | no |
| `domains` | array | no |
| `access` | value | no |
| `scopes` | array | no |
| `oauthClient` | value | no |
| `credentialsFileEnv` | string | no |
| `tokenEnv` | string | no |
<!-- /generated:accounts -->

## Sign in

| Alias | Integration |
|---|---|
| `default` | `gws` |
| `work` | `gws-work` |

- In OpenCode, run `/connect` and choose **Google Workspace** (or **Google Workspace (work)**). Paste a Desktop OAuth
  client's ID and secret, choose read-only or read and write, and approve the scopes.
- From a terminal, `opencode auth login gws-work` starts the same flow.
- A headless profile names `credentialsFileEnv` or `tokenEnv`; the value is read at call time and never stored.
- One OAuth client may serve every alias; set it once in `oauthClient` or paste it at the first sign-in.

## Choosing an account

Every method declared `accounts: "optional"` takes `account`. With one account it may be left out; with several,
omitting it is `ACCOUNT_REQUIRED`, whose next step lists the aliases. An unknown alias is `ACCOUNT_UNKNOWN`. A commit
takes no account: the register runs it as the account the plan recorded.

## Status and probe

`status` lists every alias with `ready`, `needs_sign_in` or `error`, and its owner once a probe has answered. `probe`
returns `{ source, account, owner, scopes? }` from the verified sign-in and reads no content. A sign-in that was revoked
is `NEEDS_SIGN_IN` from the first call that needs it.
