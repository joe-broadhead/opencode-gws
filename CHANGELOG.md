# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The tools RPC, `google-workspace.gws.tools`: scripts call `status`, `catalog`, `schema`, `read` and `plan` with no model, for example through `opencode api`. Each method runs the Code Mode tool's own definition as a named session and its agent, with the same permission checks; an ask is denied, since no one can answer it. `describe` lists the methods with their JSON Schemas. The commit tools are not methods.
- Error codes `SESSION_UNKNOWN`, `SESSION_AGENT_REQUIRED` and `PERMISSION_DENIED` for scripts.
- Audit records of a script's reads and plans carry `caller: "rpc"`.

### Fixed

- Invalid helper input, such as `gmail.read` without `id`, is refused with `GWS_VALIDATION_ERROR` and the helper's next step before any permission check or `gws` run, instead of a raw zod error.

## [0.0.0] - 2026-11-01

### Added

- Google Workspace tools for OpenCode through the unmodified `gws` 0.22.5 CLI: `gws_status`, `gws_catalog`, `gws_schema`, `gws_read` and `gws_plan`, and the commit tools `gws_write`, `gws_send`, `gws_share`, `gws_delete`, `gws_export` and `gws_admin`. A change is a dry-run plan, then one commit the user approves.
- Sign-in from `/connect` with a Desktop app OAuth client, read-only by default, with the scopes shown before consent. Organisation config can set the client through `oauthClient`.
- Default ask rules for every commit category; reads do not prompt.
- `/gws-status`, `/gws-doctor`, and the TUI dialog **Google Workspace: Status** (`/gws`).
- The `gws` binary in per-platform packages for macOS (arm64, x64) and Linux (arm64, x64, glibc).
- Three skills: `opencode-gws`, `opencode-gws-recipes` and `opencode-gws-admin`.
