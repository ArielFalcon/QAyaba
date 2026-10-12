import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SMOKE_SPEC_DIR, countSmokeCases, evaluateSmoke } from "./sandbox-smoke.ts";

test("the smoke run is green only when it passed, every case passed, and as many ran as the specs promise", () => {
  const pass = (name: string) => ({ name, status: "pass" as const });
  assert.equal(evaluateSmoke({ verdict: "pass", cases: [pass("a"), pass("b")] }, 2).ok, true);
  assert.equal(evaluateSmoke({ verdict: "fail", cases: [pass("a")] }, 1).ok, false);
  assert.equal(evaluateSmoke({ verdict: "pass", cases: [pass("a"), { name: "b", status: "fail" }] }, 2).ok, false);
  const missing = evaluateSmoke({ verdict: "pass", cases: [pass("a")] }, 3);
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join("\n"), /1 of 3/);
});

test("the number of cases expected follows the smoke specs, and there are specs for secrets, files and network", () => {
  const files = readdirSync(SMOKE_SPEC_DIR).filter((f) => f.endsWith(".spec.ts")).sort();
  assert.deepEqual(files, ["filesystem.spec.ts", "network.spec.ts", "secrets.spec.ts"]);
  const count = countSmokeCases(files.map((f) => readFileSync(join(SMOKE_SPEC_DIR, f), "utf8")));
  assert.ok(count >= 15, `expected at least 15 isolation checks, found ${count}`);
});

test("every smoke spec states what a pass means, so a reader cannot take a read that succeeded for a green check", () => {
  for (const f of readdirSync(SMOKE_SPEC_DIR).filter((name) => name.endsWith(".spec.ts"))) {
    assert.match(readFileSync(join(SMOKE_SPEC_DIR, f), "utf8"), /PASSES when/, f);
  }
});
