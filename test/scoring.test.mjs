import test from "node:test";
import assert from "node:assert/strict";
import { computeScore, WEIGHTS, NON_LOW_CUTOFF } from "../docker/lib.mjs";

const ZERO = { critical: 0, high: 0, medium: 0, low: 0 };

test("computeScore: no findings scores a perfect 10", () => {
  assert.equal(computeScore(ZERO, ZERO), 10);
});

test("computeScore: weights are ordered critical > high > medium > low", () => {
  assert.ok(WEIGHTS.critical > WEIGHTS.high);
  assert.ok(WEIGHTS.high > WEIGHTS.medium);
  assert.ok(WEIGHTS.medium > WEIGHTS.low);
});

test("computeScore: single medium finding deducts exactly its weight", () => {
  const sca = { ...ZERO, medium: 1 };
  assert.equal(computeScore(sca, ZERO), Math.round((10 - WEIGHTS.medium) * 10) / 10);
});

test("computeScore: SCA and SAST findings combine additively", () => {
  const sca = { ...ZERO, high: 1 };
  const sast = { ...ZERO, high: 1 };
  const expected = Math.max(0, Math.round((10 - WEIGHTS.high * 2) * 10) / 10);
  assert.equal(computeScore(sca, sast), expected);
});

test("computeScore: floors at 0 rather than going negative", () => {
  const sca = { ...ZERO, critical: 10 };
  assert.equal(computeScore(sca, ZERO), 0);
});

// Regression: more than NON_LOW_CUTOFF non-low findings must hard-fail to 0,
// even when the weighted deduction alone would land above 0.
test("computeScore: >NON_LOW_CUTOFF non-low findings forces score to 0", () => {
  const sca = { ...ZERO, medium: NON_LOW_CUTOFF + 1 };
  const weightedOnly = Math.max(0, 10 - WEIGHTS.medium * (NON_LOW_CUTOFF + 1));
  assert.ok(weightedOnly > 0, "test setup should produce a nonzero weighted score to prove the cutoff, not the formula, is what zeroes it");
  assert.equal(computeScore(sca, ZERO), 0);
});

test("computeScore: exactly NON_LOW_CUTOFF non-low findings does not trigger the hard cutoff", () => {
  const sca = { ...ZERO, medium: NON_LOW_CUTOFF };
  const result = computeScore(sca, ZERO);
  assert.ok(result > 0, "at the cutoff boundary (not over it) the weighted formula should still apply");
});

test("computeScore: low-severity findings alone never trigger the non-low cutoff", () => {
  const sca = { ...ZERO, low: 50 };
  const result = computeScore(sca, ZERO);
  assert.ok(result >= 0);
  assert.notEqual(result, 0, "50 low findings should be deducted by weight, not hard-zeroed");
});
