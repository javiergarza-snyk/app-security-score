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

- **Docker Desktop**, installed and running (`docker info` should succeed)
- **Node.js >= 20** — used to run the host-side `cli.mjs` orchestrator (Docker
  does the actual cloning/scanning; Node here just drives `docker` commands)
- **A Snyk account and Personal Access Token (PAT)** — see setup below

## Setup

1. **Create a free Snyk account** (skip if you already have one):
   [app.snyk.io/signup](https://app.snyk.io/signup?utm_source=evt_260101_aiseceng_meetups_amer_sf_2026&utm_medium=aisecurity-engineer&utm_campaign=sfhackathon)

2. **Create a Personal Access Token (PAT)**, following Snyk's official docs:
   [Personal Access Tokens (PATs)](https://docs.snyk.io/developer-tools/snyk-api/authentication-for-api/personal-access-tokens-pats)

   In short: go to your [Snyk account settings](https://app.snyk.io/account) →
   **Personal Access Tokens** tab → give it a name and expiry (max 90 days) →
   **Generate new token** → copy it immediately (Snyk only shows it once).

   Use a PAT here, not the OAuth session token from `snyk auth` — the PAT is
   scoped, has a fixed expiry, and is what actually gets exported into the
   credentialed container stage below, so a narrowly-scoped, revocable token
   is the safer thing to hand to a sandbox.

3. **Export it as `SNYK_TOKEN`** in your shell:

   ```
   export SNYK_TOKEN=<your-personal-access-token>
   ```

   Or keep it in a local file and `source` it instead of typing it inline
   every time (handy since the token shouldn't be typed into shell history
   or committed anywhere). Create e.g. `~/.secrets/snyk.env`:

   ```
   SNYK_TOKEN=<your-personal-access-token>
   ```

   Then load it into your current shell before running the CLI:

   ```
   set -a; source ~/.secrets/snyk.env; set +a
   node cli.mjs https://github.com/<owner>/<repo>
   ```

   `set -a` marks every variable `source` picks up for export, so `SNYK_TOKEN`
   is visible to the `docker` commands `cli.mjs` spawns — plain `source`
   without it only sets a shell variable, which child processes never see.
   Keep that file out of any git repo (e.g. `chmod 600 ~/.secrets/snyk.env`)
   and re-`source` it in every new terminal/session, since exported env vars
   don't persist across shells.

## Usage

```
node cli.mjs https://github.com/<owner>/<repo>
```

### Scanning multiple repos

Pass any number of repo URLs in one call — they're scanned one at a time,
each getting its own fresh sandbox (fresh clone, fresh Docker volume, fresh
containers), and each prints its own result plus a `reports/<owner>__<repo>.json`
file:

```
node cli.mjs \
  https://github.com/<owner-1>/<repo-1> \
  https://github.com/<owner-2>/<repo-2> \
  https://github.com/<owner-3>/<repo-3>
```

Combined with the token file from Setup step 3, a full multi-repo run looks
like:

```
set -a; source ~/.secrets/snyk.env; set +a
node cli.mjs \
  https://github.com/QuantumPhy/agentshare \
  https://github.com/digitalshare/forgelab \
  https://github.com/Shalupanwar06/TickTickGo
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

## Working on this repo with a coding agent

If you're using Claude Code, Codex, Cursor, or similar, see `AGENTS.md` for
how to run the tool/tests and the branch → changelog → version bump →
tests → Snyk scan → ask-to-merge workflow this repo follows for every
change.
