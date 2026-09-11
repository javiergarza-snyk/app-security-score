#!/usr/bin/env node
// app-security-score CLI
//
// Scores a public GitHub repo (or a local clone of one) 0-10 on security posture
// using Snyk SCA (`snyk test`) + SAST (`snyk code test`). The target repo is
// installed, built, and scanned entirely inside ephemeral Docker containers —
// its build tooling never touches this machine's filesystem.
//
// Two-stage isolation:
//   stage 1 (install): clone (or copy-in, for a local target) + npm/pip/uv
//                       install, NO credentials in scope.
//   stage 2 (scan):     snyk test + snyk code test, SNYK_TOKEN only injected here.
// A fresh Docker volume is created per run and destroyed afterward; nothing from
// the target repo ever touches the host disk. A local target is never
// bind-mounted — it's copied into the ephemeral volume with `docker cp`, a
// one-time snapshot copy, so the repo's own install/build scripts still only
// ever run against the in-container copy.
//
// Multiple targets run concurrently (up to CONCURRENCY at a time — override
// with SCORE_CONCURRENCY). Each target's own progress/diagnostic lines are
// buffered and flushed as one block right when that target finishes, so
// concurrent runs don't interleave into unreadable output.
//
// Usage:
//   SNYK_TOKEN=xxxx node cli.mjs <repo-url|local-path> [<repo-url|local-path> ...]
//   SNYK_TOKEN=xxxx node cli.mjs --rebuild <repo-url>   # force image rebuild

import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SKIP_DIRS } from "./docker/lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.join(HERE, "reports");
const IMAGE = "app-security-score:latest";
const CONCURRENCY = Math.max(1, Number(process.env.SCORE_CONCURRENCY) || 4);

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

// A target is "local" if it isn't a URL (no scheme like https:// or git@host:)
// and it actually exists as a directory on this machine.
export function isLocalTarget(target) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^[\w.-]+@[\w.-]+:/.test(target)) return false;
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
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

// Async replacement for spawnSync so multiple targets' docker commands can
// genuinely run concurrently (spawnSync blocks the whole event loop, which
// would serialize "concurrent" targets the moment any one of them shells out).
// stdout/stderr are captured rather than inherited — the caller decides when
// to surface them, so concurrent targets' output doesn't interleave.
function run(cmd, args, { env, input, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs)
      : null;

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error });
    });
    child.on("close", (status) => {
      if (timer) clearTimeout(timer);
      resolve({
        status,
        stdout,
        stderr,
        error: timedOut ? new Error(`command timed out after ${timeoutMs}ms`) : undefined,
      });
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

// Copies a local directory into the ephemeral volume (never a bind mount) so
// stage 1 can install/build it exactly like a freshly cloned repo. Streams a
// tar archive through `docker cp -` rather than `docker cp <src> <dest>`
// directly for two reasons: (1) it lets us --exclude vendored/build dirs
// (node_modules, .venv, etc.) so a pre-existing local install doesn't get
// dragged in — those directories can carry host-user file ownership that the
// hardened (--cap-drop ALL) install/scan containers can't rmdir/rewrite, and
// (2) a fresh install inside the sandbox is what we want anyway, matching
// what a freshly cloned repo would look like.
async function copyLocalIntoVolume(localPath, volume, log) {
  const helper = `app-security-score-copy-${randomUUID()}`;
  const mkdirRepo = await run("docker", ["run", "--rm", "-v", `${volume}:/work`, IMAGE, "mkdir", "-p", "/work/repo"]);
  if (mkdirRepo.status !== 0) {
    return { ok: false, error: `failed to prepare volume: ${(mkdirRepo.stderr || "").trim()}` };
  }

  const create = await run("docker", ["create", "--name", helper, "-v", `${volume}:/work`, IMAGE, "true"]);
  if (create.status !== 0) {
    return { ok: false, error: `failed to create copy helper: ${(create.stderr || "").trim()}` };
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "app-security-score-"));
  const tarPath = path.join(tmpDir, "repo.tar");
  try {
    const excludeArgs = [...SKIP_DIRS].flatMap((d) => ["--exclude", d]);
    // macOS's bsdtar embeds AppleDouble/xattr metadata Linux tar can't read back;
    // strip it so the archive extracts cleanly inside the (Linux) container.
    const macArgs = process.platform === "darwin" ? ["--no-mac-metadata"] : [];
    const tar = await run(
      "tar",
      ["--no-xattrs", ...macArgs, "-cf", tarPath, ...excludeArgs, "-C", localPath, "."],
      { env: { COPYFILE_DISABLE: "1" } }
    );
    if (tar.status !== 0) {
      return { ok: false, error: `tar failed: ${(tar.stderr || "").trim()}` };
    }
    const cp = await run("docker", ["cp", "-", `${helper}:/work/repo`], { input: readFileSync(tarPath) });
    if (cp.status !== 0) {
      return { ok: false, error: `docker cp failed: ${(cp.stderr || "").trim()}` };
    }
    // Archived files keep the host user's uid/gid. The install/scan stages run
    // with --cap-drop ALL (no CAP_DAC_OVERRIDE), so container-root can't
    // write into a foreign-owned directory — normalize ownership to root here
    // (with a normal, non-hardened container) so it behaves like a fresh
    // `git clone`, which is always root-owned since root wrote it.
    const chown = await run("docker", ["run", "--rm", "-v", `${volume}:/work`, IMAGE, "chown", "-R", "root:root", "/work/repo"]);
    if (chown.status !== 0) {
      return { ok: false, error: `chown failed: ${(chown.stderr || "").trim()}` };
    }
    return { ok: true };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await run("docker", ["rm", "-f", helper]);
  }
}

async function scoreRepo(target, token, log) {
  const local = isLocalTarget(target);
  const label = local ? path.resolve(target) : target;
  const volume = `app-security-score-${randomUUID()}`;
  log(`=== ${label}${local ? " (local)" : ""} ===`);
  await run("docker", ["volume", "create", volume]);

  try {
    if (local) {
      log("[local] copying repo into sandbox volume...");
      const copied = await copyLocalIntoVolume(label, volume, log);
      if (!copied.ok) return { repoUrl: label, error: copied.error, score: null };
    }

    log(`[stage 1/2] ${local ? "install" : "clone + install"} (no credentials)...`);
    const install = await run(
      "docker",
      ["run", ...DOCKER_HARDENING, "-v", `${volume}:/work`, IMAGE, "node", "/app/install.mjs", local ? "--local" : label],
      { timeoutMs: 5 * 60_000 }
    );
    if (install.stderr.trim()) log(install.stderr.trim());
    if (install.status !== 0 && install.error) {
      return { repoUrl: label, error: `stage1 failed: ${install.error.message}`, score: null };
    }

    log("[stage 2/2] snyk test + snyk code test (credentialed)...");
    const scan = await run(
      "docker",
      ["run", ...DOCKER_HARDENING, "-v", `${volume}:/work`, "-e", "SNYK_TOKEN", IMAGE, "node", "/app/scan.mjs", label],
      { env: { SNYK_TOKEN: token }, timeoutMs: 8 * 60_000 }
    );
    if (scan.stderr.trim()) log(scan.stderr.trim());
    const stdout = (scan.stdout ?? "").trim();
    if (!stdout) {
      return { repoUrl: label, error: `stage2 produced no output (exit ${scan.status})`, score: null };
    }
    try {
      return JSON.parse(stdout);
    } catch {
      return { repoUrl: label, error: "stage2 output was not valid JSON", score: null };
    }
  } finally {
    await run("docker", ["volume", "rm", "-f", volume]);
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
    .replace(/^\//, "")
    .replace(/\//g, "__");
  writeFileSync(path.join(REPORTS_DIR, `${slug}.json`), JSON.stringify(result, null, 2));
}

// Runs `worker` over `items` with at most `limit` in flight at once. Unlike
// Promise.all(items.map(worker)), this caps concurrency instead of launching
// everything at once, and each item is handled (here: logged + persisted) the
// moment it finishes rather than waiting for the whole batch.
export async function forEachWithConcurrency(items, limit, worker) {
  let next = 0;
  async function runNext() {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
}

async function main() {
  const argv = process.argv.slice(2);
  const rebuild = argv.includes("--rebuild");
  const targets = argv.filter((a) => a !== "--rebuild");
  if (targets.length === 0) {
    fail("usage: node cli.mjs [--rebuild] <repo-url|local-path> [<repo-url|local-path> ...]");
  }

  const token = process.env.SNYK_TOKEN;
  checkPrereqs(token);
  ensureImage(rebuild);

  await forEachWithConcurrency(targets, CONCURRENCY, async (target) => {
    const lines = [];
    const log = (msg) => lines.push(msg);
    const result = await scoreRepo(target, token, log);
    if (lines.length) console.error(`\n${lines.join("\n")}`);
    printResult(result);
    persistReport(result);
  });
}

// Import-safe: pure helpers above (isLocalTarget) are unit-testable without
// running the CLI as a side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => fail(err?.message ?? String(err)));
}
