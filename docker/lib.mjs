// Shared helpers used by both container stages (install.mjs, scan.mjs).
// Runs INSIDE the sandbox container only.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "dist", "build", "vendor"]);

function walkFor(root, matcher, depth) {
  const found = [];
  const walk = (dir, remaining) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (matcher(entries)) found.push(dir);
    if (remaining <= 0) return;
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), remaining - 1);
    }
  };
  walk(root, depth);
  return found;
}

export function findNpmManifestDirs(root, depth = 4) {
  return walkFor(root, (entries) => entries.some((e) => e.isFile() && e.name === "package.json"), depth);
}

export function findPipRequirementsDirs(root, depth = 4) {
  return walkFor(root, (entries) => entries.some((e) => e.isFile() && e.name === "requirements.txt"), depth);
}

export function findUvProjectDirs(root, depth = 4) {
  return walkFor(
    root,
    (entries) => entries.some((e) => e.isFile() && e.name === "pyproject.toml") &&
      entries.some((e) => e.isFile() && e.name === "uv.lock"),
    depth
  );
}

export function findPoetryProjectDirs(root, depth = 4) {
  return walkFor(
    root,
    (entries) => entries.some((e) => e.isFile() && e.name === "pyproject.toml") &&
      entries.some((e) => e.isFile() && e.name === "poetry.lock"),
    depth
  );
}

// Install npm/yarn/pnpm deps so `snyk test` can resolve a dependency tree.
export function installNpmDeps(repoDir, log) {
  const dirs = findNpmManifestDirs(repoDir);
  const warnings = [];
  for (const dir of dirs) {
    const hasLock = existsSync(path.join(dir, "package-lock.json"));
    const hasYarnLock = existsSync(path.join(dir, "yarn.lock"));
    const hasPnpmLock = existsSync(path.join(dir, "pnpm-lock.yaml"));
    const [cmd, args] = hasYarnLock
      ? ["yarn", ["install", "--silent"]]
      : hasPnpmLock
        ? ["pnpm", ["install", "--silent"]]
        : hasLock
          ? ["npm", ["ci", "--no-audit", "--no-fund"]]
          : ["npm", ["install", "--no-audit", "--no-fund"]];
    log(`[deps] ${cmd} ${args.join(" ")} in ${path.relative(repoDir, dir) || "."}`);
    const res = spawnSync(cmd, args, { cwd: dir, encoding: "utf8", timeout: 180_000 });
    if (res.status !== 0) {
      const msg = (res.stderr || res.error?.message || "install failed").trim().split("\n").slice(-3).join(" ");
      warnings.push(`npm[${path.relative(repoDir, dir) || "."}]: ${msg}`);
    }
  }
  return warnings;
}

// Install Python deps (requirements.txt into a disposable venv, or uv/poetry projects).
export function installPythonDeps(repoDir, log) {
  const warnings = [];

  for (const dir of findPipRequirementsDirs(repoDir)) {
    const venv = path.join(dir, ".snyk-venv");
    log(`[deps] python -m venv + pip install -r requirements.txt in ${path.relative(repoDir, dir) || "."}`);
    const mk = spawnSync("python3", ["-m", "venv", venv], { cwd: dir, encoding: "utf8", timeout: 60_000 });
    if (mk.status !== 0) {
      warnings.push(`pip[${path.relative(repoDir, dir) || "."}]: venv creation failed`);
      continue;
    }
    const pip = path.join(venv, "bin", "pip");
    const res = spawnSync(pip, ["install", "-r", "requirements.txt"], { cwd: dir, encoding: "utf8", timeout: 180_000 });
    if (res.status !== 0) {
      const msg = (res.stderr || res.error?.message || "pip install failed").trim().split("\n").slice(-3).join(" ");
      warnings.push(`pip[${path.relative(repoDir, dir) || "."}]: ${msg}`);
    }
  }

  for (const dir of findUvProjectDirs(repoDir)) {
    log(`[deps] uv sync in ${path.relative(repoDir, dir) || "."}`);
    let res = spawnSync("uv", ["sync"], { cwd: dir, encoding: "utf8", timeout: 180_000 });
    if (res.status !== 0) {
      // Lockfile drifted from pyproject.toml — regenerate it, then retry once.
      log(`[deps] uv sync failed, retrying after 'uv lock' in ${path.relative(repoDir, dir) || "."}`);
      spawnSync("uv", ["lock"], { cwd: dir, encoding: "utf8", timeout: 180_000 });
      res = spawnSync("uv", ["sync"], { cwd: dir, encoding: "utf8", timeout: 180_000 });
    }
    if (res.status !== 0) {
      const msg = (res.stderr || res.error?.message || "uv sync failed").trim().split("\n").slice(-3).join(" ");
      warnings.push(`uv[${path.relative(repoDir, dir) || "."}]: ${msg}`);
    }
  }

  for (const dir of findPoetryProjectDirs(repoDir)) {
    log(`[deps] poetry install in ${path.relative(repoDir, dir) || "."}`);
    const res = spawnSync("poetry", ["install", "--no-interaction"], { cwd: dir, encoding: "utf8", timeout: 180_000 });
    if (res.status !== 0) {
      const msg = (res.stderr || res.error?.message || "poetry install failed").trim().split("\n").slice(-3).join(" ");
      warnings.push(`poetry[${path.relative(repoDir, dir) || "."}]: ${msg}`);
    }
  }

  return warnings;
}

export function runJson(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
  const stdout = (res.stdout ?? "").trim();
  const stderr = (res.stderr ?? "").trim();
  if (!stdout) {
    return { error: stderr || `no output (exit ${res.status})`, raw: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { error: stderr || "failed to parse JSON output", raw: null };
  }
  // Both `snyk test` and `snyk code test` can return a valid-JSON error envelope
  // (e.g. {"ok":false,"error":"Snyk was unable to find supported files."}) instead
  // of throwing — that must NOT be read as "0 findings".
  if (parsed && !Array.isArray(parsed) && parsed.ok === false && !("vulnerabilities" in parsed)) {
    return { error: parsed.error ?? "scan reported ok:false", raw: null };
  }
  return { raw: parsed, error: null };
}

export function tallySca(raw) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  const issues = [];
  if (!raw) return { counts, issues, projects: 0 };
  const projects = Array.isArray(raw) ? raw : [raw];
  let projectCount = 0;
  for (const proj of projects) {
    if (!proj || typeof proj !== "object") continue;
    projectCount += 1;
    const vulns = Array.isArray(proj.vulnerabilities) ? proj.vulnerabilities : [];
    const seen = new Set();
    for (const v of vulns) {
      const key = v.id ?? `${v.title}:${v.packageName}:${v.version}`;
      if (seen.has(key)) continue; // dedupe repeated dependency paths to the same vuln
      seen.add(key);
      const sev = (v.severity ?? "low").toLowerCase();
      if (counts[sev] !== undefined) counts[sev] += 1;
      issues.push({
        severity: sev,
        title: v.title,
        package: v.packageName,
        version: v.version,
        id: v.id,
        target: proj.displayTargetFile,
      });
    }
  }
  return { counts, issues, projects: projectCount };
}

// SARIF `level` -> Snyk Code severity (the CLI doesn't emit a security-severity
// score, so this mirrors Snyk's own note/warning/error -> low/medium/high mapping).
export const LEVEL_TO_SEVERITY = { note: "low", warning: "medium", error: "high" };

export function tallySast(raw) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  const issues = [];
  if (!raw || !Array.isArray(raw.runs)) return { counts, issues };
  for (const run of raw.runs) {
    const rules = run?.tool?.driver?.rules ?? [];
    const ruleById = Object.fromEntries(rules.map((r) => [r.id, r]));
    for (const res of run.results ?? []) {
      const rule = ruleById[res.ruleId] ?? {};
      const sev = LEVEL_TO_SEVERITY[res.level] ?? "low";
      counts[sev] += 1;
      const loc = res.locations?.[0]?.physicalLocation;
      issues.push({
        severity: sev,
        ruleId: res.ruleId,
        title: rule.shortDescription?.text ?? res.ruleId,
        file: loc?.artifactLocation?.uri,
        line: loc?.region?.startLine,
      });
    }
  }
  return { counts, issues };
}

// Weighted deduction: start at 10, subtract per finding, floor at 0.
export const WEIGHTS = { critical: 3, high: 1, medium: 0.3, low: 0.1 };

// Fast-fail: a repo with more than 10 findings above "low" severity is
// unambiguously bad — skip the weighted math and drop it straight to 0.
export const NON_LOW_CUTOFF = 10;

export function computeScore(scaCounts, sastCounts) {
  const nonLowCount = ["critical", "high", "medium"].reduce(
    (sum, sev) => sum + (scaCounts[sev] ?? 0) + (sastCounts[sev] ?? 0),
    0
  );
  if (nonLowCount > NON_LOW_CUTOFF) return 0;

  let deduction = 0;
  for (const sev of Object.keys(WEIGHTS)) {
    deduction += WEIGHTS[sev] * ((scaCounts[sev] ?? 0) + (sastCounts[sev] ?? 0));
  }
  const score = Math.max(0, 10 - deduction);
  return Math.round(score * 10) / 10;
}
