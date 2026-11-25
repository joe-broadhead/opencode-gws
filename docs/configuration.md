# Configuration

The plugin's options are validated at setup. `access`, `accounts` and `allowUntestedHost` are the contract's; the rest
are gws-specific.

<!-- generated:configuration -->
| Option | Type | Default | Description |
|---|---|---|---|
| `access` | `all` \| `ask-changes` \| `read-only` | `"all"` | How much the plugin's methods may do: everything, reads without asking and changes after an ask, or reads only. |
| `accounts` | object | — | One profile per account alias. With no accounts option there is one default account. |
| `allowUntestedHost` | boolean | `false` | Start outside the tested OpenCode range. |
| `services` | array | — | The services the model may see, such as gmail or drive. Default: every service the accounts enable. |
| `oauthClient` | value | — | A Google OAuth client: a Desktop app's ID and secret, or Google's downloaded client JSON. None ships with the plugin. |
| `redirectUri` | string | — | The absolute URL Google redirects to, when the host supplies one. |
| `callbackPort` | integer | — | The local port the redirect reaches. |
| `policy` | object | `{}` | Deny-only content and recipient rules, and how long a plan stays committable. |
| `execution` | object | `{}` | Limits and the timeout for gws runs and file transfers. |
| `audit` | object | `{}` | Whether to record one JSON line per call, and where. |
| `binary` | object | `{}` | An alternative gws 0.22.5 executable; by default the pinned, verified download is used. |
| `admin` | object | `{}` | Allow admin-class operations, require a reason, and choose the admin services. |
<!-- /generated:configuration -->

## Examples

One interactive account with the default services:

```json
{
  "plugins": [{ "package": "github:we-the-rebel-alliance/gws-plugin#v0.0.0" }]
}
```

Two accounts, a narrower service list, and changes that ask first:

```json
{
  "plugins": [
    {
      "package": "github:we-the-rebel-alliance/gws-plugin#v0.0.0",
      "options": {
        "access": "ask-changes",
        "services": ["gmail", "calendar", "drive"],
        "accounts": {
          "work": { "enabledServices": ["gmail", "calendar", "drive"] },
          "personal": { "mode": "access_token", "enabledServices": ["drive"], "tokenEnv": "GWS_PERSONAL_TOKEN" }
        }
      }
    }
  ]
}
```

A deny-only recipient rule:

```json
{
  "options": {
    "policy": {
      "rules": [
        { "id": "internal-only", "effect": "deny", "categories": ["send", "share"], "allowedRecipientDomains": ["example.com"] }
      ]
    }
  }
}
```
