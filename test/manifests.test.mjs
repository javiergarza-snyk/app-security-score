import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findNpmManifestDirs,
  findPipRequirementsDirs,
  findUvProjectDirs,
  findPoetryProjectDirs,
} from "../docker/lib.mjs";

function withTempRepo(build) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "app-security-score-test-"));
  try {
    build(dir);
    return dir;
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

test("findNpmManifestDirs: finds nested package.json but skips node_modules", (t) => {
  const dir = withTempRepo((root) => {
    writeFileSync(path.join(root, "package.json"), "{}");
    mkdirSync(path.join(root, "frontend"), { recursive: true });
    writeFileSync(path.join(root, "frontend", "package.json"), "{}");
    mkdirSync(path.join(root, "node_modules", "some-dep"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "some-dep", "package.json"), "{}");
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const found = findNpmManifestDirs(dir).map((d) => path.relative(dir, d) || ".");
  assert.deepEqual(found.sort(), [".", "frontend"]);
});

test("findPipRequirementsDirs: finds requirements.txt", (t) => {
  const dir = withTempRepo((root) => {
    writeFileSync(path.join(root, "requirements.txt"), "requests==2.0.0\n");
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const found = findPipRequirementsDirs(dir);
  assert.equal(found.length, 1);
  assert.equal(found[0], dir);
});

test("findUvProjectDirs: requires BOTH pyproject.toml and uv.lock", (t) => {
  const dir = withTempRepo((root) => {
    writeFileSync(path.join(root, "pyproject.toml"), "[project]\nname='x'\n");
    // no uv.lock yet
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(findUvProjectDirs(dir).length, 0);
  writeFileSync(path.join(dir, "uv.lock"), "");
  assert.equal(findUvProjectDirs(dir).length, 1);
});

test("findPoetryProjectDirs: requires BOTH pyproject.toml and poetry.lock", (t) => {
  const dir = withTempRepo((root) => {
    writeFileSync(path.join(root, "pyproject.toml"), "[tool.poetry]\nname='x'\n");
    writeFileSync(path.join(root, "poetry.lock"), "");
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(findPoetryProjectDirs(dir).length, 1);
});

test("manifest finders: empty repo yields no matches anywhere", (t) => {
  const dir = withTempRepo(() => {});
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(findNpmManifestDirs(dir).length, 0);
  assert.equal(findPipRequirementsDirs(dir).length, 0);
  assert.equal(findUvProjectDirs(dir).length, 0);
  assert.equal(findPoetryProjectDirs(dir).length, 0);
});
