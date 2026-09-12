import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLocalTarget, forEachWithConcurrency } from "../cli.mjs";

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

test("forEachWithConcurrency: processes every item exactly once", async () => {
  const items = [1, 2, 3, 4, 5, 6, 7];
  const seen = [];
  await forEachWithConcurrency(items, 3, async (item) => {
    seen.push(item);
  });
  assert.deepEqual(seen.slice().sort((a, b) => a - b), items);
});

test("forEachWithConcurrency: never exceeds the concurrency limit", async () => {
  const limit = 3;
  let inFlight = 0;
  let maxInFlight = 0;
  await forEachWithConcurrency(Array.from({ length: 10 }, (_, i) => i), limit, async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
  });
  assert.ok(maxInFlight <= limit, `expected maxInFlight <= ${limit}, got ${maxInFlight}`);
  assert.ok(maxInFlight > 1, "expected some real concurrency, not fully serialized");
});

test("forEachWithConcurrency: propagates a worker error", async () => {
  await assert.rejects(
    forEachWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error("boom");
    }),
    /boom/
  );
});
