#!/usr/bin/env node
// app-security-score CLI
//
// Scores a public GitHub repo 0-10 on security posture using Snyk SCA (`snyk test`)
// + SAST (`snyk code test`). The target repo is cloned, built, and scanned entirely
// inside ephemeral Docker containers — never on this machine's filesystem.
//
// Two-stage isolation:
//   stage 1 (install): clone + npm/pip/uv install, NO credentials in scope.
//   stage 2 (scan):     snyk test + snyk code test, SNYK_TOKEN only injected here.
// A fresh Docker volume is created per run and destroyed afterward; nothing from
// the target repo ever touches the host disk.
//
// Usage:
//   SNYK_TOKEN=xxxx node cli.mjs <repo-url> [<repo-url> ...]
//   SNYK_TOKEN=xxxx node cli.mjs --rebuild <repo-url>   # force image rebuild

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.join(HERE, "reports");
const IMAGE = "app-security-score:latest";

const DOCKER_HARDENING = [
  "--rm",
  "--network", "bridge",
  "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges:true",
  "--pids-limit", "512",
  "--memory", "3g",
];

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function checkPrereqs(token) {
  if (!token) {
    fail(
      "SNYK_TOKEN is not set. Generate a personal API token at https://app.snyk.io/account " +
        "and run: export SNYK_TOKEN=<token>"
    );
  }
  const ver = spawnSync("docker", ["--version"], { encoding: "utf8" });
  if (ver.status !== 0) fail("docker CLI not found. Install Docker Desktop first.");
  const info = spawnSync("docker", ["info"], { encoding: "utf8" });
  if (info.status !== 0) fail("Docker daemon is not running. Start Docker Desktop and try again.");
}

function ensureImage(rebuild) {
  const exists = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" }).status === 0;
  if (exists && !rebuild) return;
  console.error(`[docker] building ${IMAGE}...`);
  const build = spawnSync("docker", ["build", "-t", IMAGE, "-f", path.join(HERE, "Dockerfile"), HERE], {
    stdio: "inherit",
  });
  if (build.status !== 0) fail("docker build failed");
}

function runStage(args, { env, timeoutMs }) {
  return spawnSync("docker", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 64,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"], // stdout captured, stderr streamed live
  });
}

function scoreRepo(repoUrl, token) {
  const volume = `app-security-score-${randomUUID()}`;
  console.error(`\n=== ${repoUrl} ===`);
  spawnSync("docker", ["volume", "create", volume], { encoding: "utf8" });

  try {
    console.error("[stage 1/2] clone + install (no credentials)...");
    const install = runStage(
      ["run", ...DOCKER_HARDENING, "-v", `${volume}:/work`, IMAGE, "node", "/app/install.mjs", repoUrl],
      { env: {}, timeoutMs: 5 * 60_000 }
    );
    if (install.status !== 0 && install.error) {
      return { repoUrl, error: `stage1 failed: ${install.error.message}`, score: null };
    }

    console.error("[stage 2/2] snyk test + snyk code test (credentialed)...");
    const scan = runStage(
      ["run", ...DOCKER_HARDENING, "-v", `${volume}:/work`, "-e", "SNYK_TOKEN", IMAGE, "node", "/app/scan.mjs", repoUrl],
      { env: { SNYK_TOKEN: token }, timeoutMs: 8 * 60_000 }
    );
    const stdout = (scan.stdout ?? "").trim();
    if (!stdout) {
      return { repoUrl, error: `stage2 produced no output (exit ${scan.status})`, score: null };
    }
    try {
      return JSON.parse(stdout);
    } catch {
      return { repoUrl, error: "stage2 output was not valid JSON", score: null };
    }
  } finally {
    spawnSync("docker", ["volume", "rm", "-f", volume], { encoding: "utf8" });
  }
}

// Critical is folded into "High" for the printed summary, per the requested
// First-party Code / Dependencies H:n M:n L:n format.
function displayCounts(counts) {
  return { H: (counts.critical ?? 0) + (counts.high ?? 0), M: counts.medium ?? 0, L: counts.low ?? 0 };
}

function printResult(result) {
  console.log(`\nRepo: ${result.repoUrl}`);
  if (result.error) {
    console.log(`  ERROR: ${result.error}`);
    return;
  }
  const code = displayCounts(result.sast.counts);
  const deps = displayCounts(result.sca.counts);
  console.log(`  First-party Code:  H:${code.H} M:${code.M} L:${code.L}`);
  console.log(`  Dependencies:      H:${deps.H} M:${deps.M} L:${deps.L}`);
  console.log(`  Score: ${result.score}/10`);

  const notes = [];
  if (!result.coverage?.sca) notes.push(`Dependency scan did not run (${result.sca.error})`);
  if (!result.coverage?.sast) notes.push(`Code scan did not run (${result.sast.error})`);
  for (const w of result.installWarnings ?? []) notes.push(`install warning: ${w}`);
  if (notes.length) {
    console.log("  Notes:");
    for (const n of notes) console.log(`    - ${n}`);
  }
}

function persistReport(result) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const slug = result.repoUrl
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\//g, "__");
  writeFileSync(path.join(REPORTS_DIR, `${slug}.json`), JSON.stringify(result, null, 2));
}

function main() {
  const argv = process.argv.slice(2);
  const rebuild = argv.includes("--rebuild");
  const urls = argv.filter((a) => a !== "--rebuild");
  if (urls.length === 0) {
    fail("usage: node cli.mjs [--rebuild] <repo-url> [<repo-url> ...]");
  }

  const token = process.env.SNYK_TOKEN;
  checkPrereqs(token);
  ensureImage(rebuild);

  for (const url of urls) {
    const result = scoreRepo(url, token);
    printResult(result);
    persistReport(result);
  }
}

main();
