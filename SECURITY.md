# Security policy

## Reporting

Report a vulnerability privately to the maintainers of `we-the-rebel-alliance/gws-plugin` through GitHub's private
vulnerability reporting, or by opening a minimal issue that names no secret and no personal data. Do not open a public
issue with a token, a credential or a person's data.

Include the plugin version, the OpenCode version, the account mode (interactive, credentials file or access token), the
method called, and the smallest input that reproduces the problem. Redact every secret and every address.

## What the plugin protects

- Credentials stay in OpenCode's credential store; an access token exists only in the `gws` child's environment.
- The pinned `gws` executable is checked against its SHA-256 and refuses a writable or project-local copy.
- Every change is planned and previewed before a single-use commit; the policy and the admin gate are deny-only.
- Logs, status and errors never carry a token, a body, a file's content or a URL query string.

## Supported versions

Only the latest release on plugin-contract v0 is supported. A vulnerability fix ships as a patch release on that line.
