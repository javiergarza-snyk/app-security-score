# Agent instructions

Instructions for coding agents (Claude Code, Codex, Cursor, or any other
agent) working in this repo. `CLAUDE.md` in this repo just points here.

## What this is

`app-security-score` scores a public GitHub repo 0-10 on security posture
using Snyk SCA (`snyk test`) + SAST (`snyk code test`), running entirely
inside ephemeral Docker containers. See `README.md` for the full design
(two-stage credential isolation) and setup (Docker, Node >= 20, Snyk PAT).

## Running the tool

```
export SNYK_TOKEN=<personal-access-token>   # or source a local token file, see README
node cli.mjs https://github.com/<owner>/<repo>
node cli.mjs <repo-url-1> <repo-url-2> ...    # multiple repos in one call
node cli.mjs --rebuild <repo-url>             # force sandbox image rebuild
```

Requires Docker Desktop running (`docker info` must succeed) — if it isn't,
ask the human to start it rather than trying to work around it.

## Running tests

```
npm test
```

Runs `node --test` (Node's built-in test runner) over `test/*.test.mjs`.
These are pure unit tests against `docker/lib.mjs` (scoring formula, SCA/SAST
tallying, manifest detection) — no Docker or network access required.

## Standing workflow for code changes — follow this for every change

1. **Branch** — never commit code changes directly to `main`.
2. **Implement** the change.
3. **Update `CHANGELOG.md`** — add an entry under an `[Unreleased]` or new
   version heading describing what changed.
4. **Bump the version** in `package.json` (`major.minor`, semver-style —
   patch is not used in this project). Bump minor for additions/fixes,
   major only for breaking changes to the CLI's interface/output.
5. **Add functional and/or regression tests** in `test/` for the change.
   Run `npm test` and confirm everything passes.
6. **Run a Snyk scan on the change itself** (this repo's own source is
   trusted, so this runs directly on the host, not through the sandbox):
   ```
   snyk test
   snyk code test
   ```
7. Only after tests and the scan both pass, **ask the human** whether to
   merge the branch into `main` or keep iterating on it. Don't merge
   unprompted.

Do not skip steps 3-6 even for small changes.

## Things to be careful about

- **Don't weaken the two-stage credential isolation.** `docker/install.mjs`
  (stage 1: clone + dependency install) must never receive `SNYK_TOKEN`.
  Only `docker/scan.mjs` (stage 2) is credentialed. If you're touching
  `cli.mjs`'s `docker run` invocations, keep that separation intact.
- **Don't bind-mount host paths into either container stage.** The whole
  point of the sandbox is that a scanned repo's build tooling never touches
  this machine's filesystem. Only the ephemeral, per-run named Docker volume
  should be shared between the two stages.
- **Don't commit real corporate CA certs.** `docker/certs/*.crt` is
  gitignored on purpose (see `docker/certs/README.md`) — it's a local-only
  escape hatch for TLS-inspecting proxies, not something to publish.
- **Don't commit `reports/`** — it's generated scan output (gitignored),
  not tool source.
- **This project is unrelated to `snyk-strike`** (a different, unrelated
  project in this user's environment — a vulnerability-themed arcade game).
  Don't pull in code, dependencies, or conventions from it.
