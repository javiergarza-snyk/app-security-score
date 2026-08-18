import test from "node:test";
import assert from "node:assert/strict";
import { runJson } from "../docker/lib.mjs";

function nodeEcho(jsonString) {
  return ["-e", `console.log(${JSON.stringify(jsonString)})`];
}

test("runJson: valid vulnerabilities payload is returned with no error", () => {
  const payload = JSON.stringify({ ok: true, vulnerabilities: [{ id: "X", severity: "low" }] });
  const { raw, error } = runJson("node", nodeEcho(payload), process.cwd());
  assert.equal(error, null);
  assert.deepEqual(raw.vulnerabilities, [{ id: "X", severity: "low" }]);
});

// Regression: `snyk test` / `snyk code test` can return valid JSON that is
// actually a failure envelope, e.g. {"ok":false,"error":"...no supported files..."}.
// This must be surfaced as an error, not silently treated as "0 findings".
test("runJson: {ok:false} envelope is treated as an error, not empty success", () => {
  const payload = JSON.stringify({ ok: false, error: "Snyk was unable to find supported files." });
  const { raw, error } = runJson("node", nodeEcho(payload), process.cwd());
  assert.equal(raw, null);
  assert.equal(error, "Snyk was unable to find supported files.");
});

test("runJson: {ok:false} envelope that DOES carry vulnerabilities is not misread as an error", () => {
  // Some SCA project results include ok:false (meaning "vulnerable", not "scan failed")
  // alongside a real vulnerabilities array -- that must still be treated as data.
  const payload = JSON.stringify({ ok: false, vulnerabilities: [{ id: "X", severity: "high" }] });
  const { raw, error } = runJson("node", nodeEcho(payload), process.cwd());
  assert.equal(error, null);
  assert.deepEqual(raw.vulnerabilities, [{ id: "X", severity: "high" }]);
});

test("runJson: non-JSON stdout is reported as a parse error", () => {
  const { raw, error } = runJson("node", ["-e", "console.log('not json')"], process.cwd());
  assert.equal(raw, null);
  assert.ok(error);
});

test("runJson: empty stdout is reported as an error rather than crashing", () => {
  const { raw, error } = runJson("node", ["-e", ""], process.cwd());
  assert.equal(raw, null);
  assert.ok(error);
});
