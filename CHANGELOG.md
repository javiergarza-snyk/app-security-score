# Changelog

All notable changes to this project are documented in this file.
Versioning follows `major.minor` (semver-style, patch omitted for this project's size).

## [1.4.0] - Unreleased

### Added
- Local-clone scanning: `node cli.mjs <local-path>` now scores a repo you've
  already cloned to disk, in addition to a GitHub URL. The local directory is
  streamed into the same ephemeral, per-run Docker volume as a tar archive
  piped through `docker cp -` (never a bind mount), excluding vendored/build
  directories (`node_modules`, `.venv`, `.git`, etc.) so a pre-existing local
  install isn't dragged in, and then `chown -R root:root` inside the volume
  (via a normal, non-hardened container) so the copy's ownership matches what
  a fresh `git clone` would produce. That last step matters: the install/scan
  containers run with `--cap-drop ALL`, so without it, container-root can't
  write into a directory that still carries the host user's original uid/gid
  — install/build scripts still only ever run inside the sandbox, and the
  two-stage credential isolation is unchanged.

## [1.3.0] - Unreleased

### Changed
- Sandbox `Dockerfile` base image switched from `node:20-bookworm-slim` to
  `node:22-alpine`. The Debian bookworm base carried 127 unique OS-level
  vulnerabilities (4 critical, 14 high — none with an available fix in
  Debian 12's perl/util-linux/zlib packages, so no Debian tag bump could
  reach zero); `node:22-alpine` has 10, all low severity, none critical/high.
  `apt-get` packages were swapped for their `apk` equivalents (`build-base`,
  `python3-dev`, `linux-headers` added for native npm/Python extension
  builds); the apk repository URLs were switched to `http://` (package
  integrity is enforced by apk's own signing, not transport TLS — matching
  the pattern the Debian base already used) since some `https://` egress
  paths get intercepted by TLS-inspecting corporate proxies before the
  `docker/certs/` CA trust step runs; and the `docker/certs/` corporate-CA
  `COPY` destination was flattened (Alpine's `update-ca-certificates`,
  unlike Debian's, doesn't scan subdirectories). Verified npm native addons
  (node-gyp), pip C-extension builds, and `uv sync` all still work under
  musl libc.

## [1.2.0] - Unreleased

### Added
- `AGENTS.md` — instructions for coding agents (Claude Code, Codex, Cursor,
  etc.) working in this repo: how to run the tool, requirements, the
  branch/changelog/version/test/scan workflow, and the credential-isolation
  design so agents don't accidentally weaken it. `CLAUDE.md` points here.
- README: documented scanning multiple repos in one `cli.mjs` call, and an
  example of keeping `SNYK_TOKEN` in a local file (e.g. `~/.secrets/snyk.env`)
  and `source`-ing it instead of typing the token inline.

## [1.1.0] - 2026-08-18

### Added
- `CHANGELOG.md` (this file) to track changes going forward.
- Functional + regression test suite (`test/`) using Node's built-in test
  runner (`node --test`), covering the scoring formula, SCA/SAST tallying,
  manifest detection, and the `ok:false` coverage-gap fix.
- `npm test` script in `package.json`.

## [1.0.0] - 2026-08-17

### Added
- Initial release: Docker-sandboxed CLI (`cli.mjs`) that scores a public
  GitHub repo 0-10 using Snyk SCA (`snyk test`) + SAST (`snyk code test`).
- Two-stage container isolation: an uncredentialed `install` stage
  (clone + npm/yarn/pnpm/pip/uv install) and a credentialed `scan` stage
  (only this stage receives `SNYK_TOKEN`), sharing one ephemeral Docker
  volume that's destroyed after each run. No host paths are bind-mounted.
- Weighted scoring: `10 − (critical×3 + high×1 + medium×0.3 + low×0.1)`,
  floored at 0; a repo with more than 10 combined non-low findings scores
  0 outright.
- Coverage-gap detection: a scan stage that returns `{"ok": false, ...}`
  (e.g. "no supported files") is reported as a skipped scan with a reason,
  never silently counted as "0 findings, full score."
- Auto dependency installation for npm/yarn/pnpm and Python
  (`requirements.txt` via a disposable venv, or `uv`/`poetry` projects)
  before the SCA scan runs, so dependency trees actually resolve.
- Corporate TLS proxy support (`docker/certs/`) — drop a root CA `.crt` in
  to let the Docker build succeed behind interception proxies (e.g.
  Zscaler); gitignored, never published.
- `README.md` covering requirements (Docker, Node >= 20), free Snyk signup,
  Personal Access Token creation, and usage.
