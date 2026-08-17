# app-security-score

Scores a public GitHub repo **0-10** on security posture using Snyk SCA
(`snyk test`) + SAST (`snyk code test`). The target repo is cloned, built, and
scanned entirely inside ephemeral Docker containers — it never touches this
machine's filesystem.

## How it's sandboxed

Two isolated stages, each a fresh `--rm` container sharing one ephemeral
Docker volume created just for that run:

1. **install** (untrusted, no credentials) — clones the repo and runs
   `npm`/`yarn`/`pnpm`/`pip`/`uv install` as needed. `SNYK_TOKEN` is never in
   scope here, so a malicious `postinstall` script can't read it.
2. **scan** (credentialed) — runs `snyk test` + `snyk code test` against the
   already-built repo. Only this stage receives `SNYK_TOKEN`.

The volume is destroyed after every run. No host paths are ever bind-mounted
into either container.

## Requirements

- Docker Desktop (running)
- A Snyk **personal API token** (Account Settings → Auth Token at
  https://app.snyk.io/account) — not your CLI's OAuth session token, since
  that's exported into the credentialed stage and a long-lived, narrowly
  scoped token is safer to hand to a sandbox.

## Usage

```
export SNYK_TOKEN=<your-snyk-api-token>
node cli.mjs https://github.com/<owner>/<repo>
```

Score multiple repos in one call:

```
node cli.mjs <repo-url-1> <repo-url-2> ...
```

Force a rebuild of the sandbox image (e.g. after editing `docker/*.mjs`):

```
node cli.mjs --rebuild <repo-url>
```

### Output

```
Repo: https://github.com/<owner>/<repo>
  First-party Code:  H:0 M:0 L:1
  Dependencies:      H:0 M:0 L:0
  Score: 9.9/10
```

`H`/`M`/`L` = High/Medium/Low severity findings (Critical findings are folded
into `H`). Score = `10 − (critical×3 + high×1 + medium×0.3 + low×0.1)`,
floored at 0 across SCA + SAST combined; a repo with more than 10 findings
above "low" severity is scored 0 outright.

If a scan stage couldn't actually run (e.g. a Python project with no
supported lockfile), that's reported under `Notes:` rather than silently
counted as "0 findings" — the score should never look better than it is
because a scan step didn't have anything to check.

## Corporate TLS proxies

If the Docker build fails with a certificate error (e.g. behind Zscaler),
drop your corporate root CA `.crt` into `docker/certs/` — see
`docker/certs/README.md`. Files there are gitignored and never published.
