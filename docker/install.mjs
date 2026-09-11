#!/usr/bin/env node
// Stage 1 (untrusted, no credentials): clone the target repo (or, in --local
// mode, use the copy the host already placed in /work/repo) and install its
// declared dependencies inside the sandbox. Runs with no SNYK_TOKEN in scope —
// whatever install/postinstall scripts the repo runs can't see it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installNpmDeps, installPythonDeps } from "./lib.mjs";

const WORK_DIR = process.env.WORK_DIR ?? "/work";
const repoArg = process.argv[2];
const isLocal = repoArg === "--local";

if (!repoArg) {
  console.error("usage: install.mjs <repo-url>|--local");
  process.exit(2);
}

function log(msg) {
  console.error(msg);
}

const repoDir = path.join(WORK_DIR, "repo");
mkdirSync(WORK_DIR, { recursive: true });

if (isLocal) {
  // The host CLI already copied the local repo into /work/repo via `docker cp`
  // (never a bind mount) before running this stage — nothing to clone.
  log("[local] using repo copied into /work/repo");
  if (!existsSync(repoDir)) {
    const status = { ok: false, stage: "clone", error: "--local mode but /work/repo was not pre-populated" };
    writeFileSync(path.join(WORK_DIR, "install-status.json"), JSON.stringify(status, null, 2));
    log(status.error);
    process.exit(1);
  }
} else {
  log(`[git] cloning ${repoArg}`);
  const clone = spawnSync("git", ["clone", "--depth", "1", repoArg, repoDir], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (clone.status !== 0) {
    const status = { ok: false, stage: "clone", error: (clone.stderr || "clone failed").trim() };
    writeFileSync(path.join(WORK_DIR, "install-status.json"), JSON.stringify(status, null, 2));
    log(status.error);
    process.exit(1);
  }
}

const warnings = [...installNpmDeps(repoDir, log), ...installPythonDeps(repoDir, log)];

const status = { ok: true, stage: "install", warnings };
writeFileSync(path.join(WORK_DIR, "install-status.json"), JSON.stringify(status, null, 2));
log(`[deps] done (${warnings.length} warning(s))`);
