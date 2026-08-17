#!/usr/bin/env node
// Stage 2 (credentialed): runs `snyk test` (SCA) + `snyk code test` (SAST) against
// the already-cloned, already-installed repo from stage 1. Only this stage ever
// sees SNYK_TOKEN. Prints exactly one JSON object to stdout; everything else to stderr.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runJson, tallySca, tallySast, computeScore } from "./lib.mjs";

const WORK_DIR = process.env.WORK_DIR ?? "/work";
const repoDir = path.join(WORK_DIR, "repo");
const repoUrl = process.argv[2] ?? "unknown";

function log(msg) {
  console.error(msg);
}

if (!existsSync(repoDir)) {
  console.log(JSON.stringify({ repoUrl, error: "stage1 (clone/install) never produced /work/repo", score: null }));
  process.exit(1);
}

let installStatus = { ok: true, warnings: [] };
const statusPath = path.join(WORK_DIR, "install-status.json");
if (existsSync(statusPath)) {
  try {
    installStatus = JSON.parse(readFileSync(statusPath, "utf8"));
  } catch {
    // ignore malformed status file, proceed with scan anyway
  }
}

log("[snyk] running `snyk test --all-projects --json` (SCA)...");
const sca = runJson("snyk", ["test", "--all-projects", "--json"], repoDir);
log("[snyk] running `snyk code test --json` (SAST)...");
const sast = runJson("snyk", ["code", "test", "--json"], repoDir);

const scaTally = tallySca(sca.raw);
const sastTally = tallySast(sast.raw);
const score = computeScore(scaTally.counts, sastTally.counts);

const result = {
  repoUrl,
  score,
  coverage: { sca: !sca.error, sast: !sast.error },
  installWarnings: installStatus.warnings ?? [],
  sca: { counts: scaTally.counts, issues: scaTally.issues, projects: scaTally.projects, error: sca.error },
  sast: { counts: sastTally.counts, issues: sastTally.issues, error: sast.error },
};

console.log(JSON.stringify(result));
