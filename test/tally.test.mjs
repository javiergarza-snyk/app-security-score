import test from "node:test";
import assert from "node:assert/strict";
import { tallySca, tallySast, LEVEL_TO_SEVERITY } from "../docker/lib.mjs";

test("tallySca: counts severities and dedupes repeated dependency paths to the same vuln", () => {
  const raw = {
    ok: true,
    displayTargetFile: "package.json",
    vulnerabilities: [
      { id: "SNYK-1", severity: "high", title: "A", packageName: "left-pad", version: "1.0.0" },
      { id: "SNYK-1", severity: "high", title: "A", packageName: "left-pad", version: "1.0.0" }, // duplicate path
      { id: "SNYK-2", severity: "medium", title: "B", packageName: "foo", version: "2.0.0" },
    ],
  };
  const { counts, issues, projects } = tallySca(raw);
  assert.equal(counts.high, 1, "duplicate vuln id should be deduped, not double-counted");
  assert.equal(counts.medium, 1);
  assert.equal(issues.length, 2);
  assert.equal(projects, 1);
});

test("tallySca: handles --all-projects array shape and sums across projects", () => {
  const raw = [
    { ok: true, displayTargetFile: "a/package.json", vulnerabilities: [{ id: "X1", severity: "critical" }] },
    { ok: true, displayTargetFile: "b/package.json", vulnerabilities: [{ id: "X2", severity: "low" }] },
  ];
  const { counts, projects } = tallySca(raw);
  assert.equal(projects, 2);
  assert.equal(counts.critical, 1);
  assert.equal(counts.low, 1);
});

test("tallySca: null/absent raw means zero findings across zero projects", () => {
  const { counts, issues, projects } = tallySca(null);
  assert.deepEqual(counts, { critical: 0, high: 0, medium: 0, low: 0 });
  assert.equal(issues.length, 0);
  assert.equal(projects, 0);
});

test("tallySast: maps SARIF levels to Snyk severities (note/warning/error -> low/medium/high)", () => {
  assert.equal(LEVEL_TO_SEVERITY.note, "low");
  assert.equal(LEVEL_TO_SEVERITY.warning, "medium");
  assert.equal(LEVEL_TO_SEVERITY.error, "high");

  const raw = {
    runs: [
      {
        tool: { driver: { rules: [{ id: "js/Rule1", shortDescription: { text: "Some issue" } }] } },
        results: [
          { ruleId: "js/Rule1", level: "error", locations: [{ physicalLocation: { artifactLocation: { uri: "a.js" }, region: { startLine: 3 } } }] },
          { ruleId: "js/Rule1", level: "warning", locations: [] },
          { ruleId: "js/Rule1", level: "note", locations: [] },
        ],
      },
    ],
  };
  const { counts, issues } = tallySast(raw);
  assert.deepEqual(counts, { critical: 0, high: 1, medium: 1, low: 1 });
  assert.equal(issues[0].title, "Some issue");
  assert.equal(issues[0].file, "a.js");
  assert.equal(issues[0].line, 3);
});

test("tallySast: missing/malformed raw yields zero findings instead of throwing", () => {
  assert.deepEqual(tallySast(null).counts, { critical: 0, high: 0, medium: 0, low: 0 });
  assert.deepEqual(tallySast({}).counts, { critical: 0, high: 0, medium: 0, low: 0 });
});
