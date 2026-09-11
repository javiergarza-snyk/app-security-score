import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLocalTarget } from "../cli.mjs";

test("isLocalTarget: https URL is not local", () => {
  assert.equal(isLocalTarget("https://github.com/owner/repo"), false);
});

test("isLocalTarget: http URL is not local", () => {
  assert.equal(isLocalTarget("http://example.com/owner/repo"), false);
});

test("isLocalTarget: scp-like git URL is not local", () => {
  assert.equal(isLocalTarget("git@github.com:owner/repo.git"), false);
});

test("isLocalTarget: existing local directory is local", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "app-security-score-test-"));
  try {
    assert.equal(isLocalTarget(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isLocalTarget: non-existent path is not local", () => {
  assert.equal(isLocalTarget("/no/such/path/hopefully-nowhere"), false);
});
