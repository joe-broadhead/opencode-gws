# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.0.0 (unreleased)

The first release under `we-the-rebel-alliance`, rebuilt greenfield: no compatibility paths, and only the OpenCode
release it is tested on.

### Changed

- **The package and repository are renamed.** `@joe-broadhead/opencode-gws` is now
  `@we-the-rebel-alliance/gws-plugin`, at version `0.0.0`, and every install line, badge and doc link names the new
  repository on `master`.
- **OpenCode 2.4.1 exactly.** The plugin supports `>=2.4.1 <2.5.0`, is tested on 2.4.1, and refuses any other host with
  `HOST_UNTESTED` unless `allowUntestedHost` is set. The 2.2 and 2.3 test matrices and their code paths are gone.
- **The namespace line and the two skill descriptions are shorter**, within the plugin standard's fixed-context budget
  (400 characters for the namespace line, 300 for each skill description). The six per-class commit tools keep their
  one-tool-per-class shape, with shorter descriptions; a single merged commit tool is not used, because each method has
  one class and access is decided per class.

### Removed

- **The plugin no longer registers an RPC named after the package.** Its two read-only methods, `calendar.today` and
  `images.read`, are gone; the same readers remain as the source contract's snapshot methods on the tools RPC,
  `calendar_today` and `images_read`. The deprecation note that `calendar.today` wrote into status, the `/gws-status`
  row and the status dialog for it are gone with it, and audit records for the two reads are now named
  `calendar_today` and `images_read`.
- **`docs/jelly.md`** and every link to it; app guides live in each app's own repository.
- **Legacy cursor acceptance.** A Gmail cursor from the source contract's version 1 is refused, and so is a Calendar
  cursor from 0.0.8 (a Google sync token) or 0.0.12 (no checkpoint), or one without the checkpoint version, its
  page fingerprint or its bounds. Each is `CURSOR_INVALID`, and the consumer starts again with `since`; a Calendar
  cursor from this release is the only shape read.
