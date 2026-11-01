/* The engine's rule about a delivered test that intercepts requests: it is refused like a skipped or expected-to-fail test, from the facts the caller read in the spec's text. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasProof, modeRefusals, refuseOutright, tallyOf, verdictAfterRefusal } from "@kernel/case-proof.ts";
import type { QaCase } from "@kernel/qa-case.ts";

const caseOf = (file: string, title: string, over: Partial<QaCase> = {}): QaCase => ({ name: `${file} › ${title}`, status: "pass", expectedStatus: "passed", file, ...over });

test("outright refusal takes a test that intercepts requests out of the report as a failing case, passing or not, and leaves the others of the judged files", () => {
  const judged = refuseOutright(
    {
      cases: [caseOf("flows/a.spec.ts", "geo › stubs the chips"), caseOf("flows/a.spec.ts", "geo › reads the chips"), caseOf("flows/b.spec.ts", "geo › stubs the chips")],
      interceptedTests: [{ file: "flows/a.spec.ts", name: "geo › stubs the chips" }, { file: "flows/a.spec.ts", name: "never ran" }, { file: "flows/b.spec.ts", name: "geo › stubs the chips" }],
    },
    ["flows/a.spec.ts"],
  );
  assert.deepEqual(judged.cases.map((c) => c.name), ["flows/a.spec.ts › geo › reads the chips", "flows/b.spec.ts › geo › stubs the chips"], "a file the run did not deliver keeps its cases");
  assert.deepEqual(judged.refused.map((c) => [c.name, c.status, c.refused, c.file]), [
    ["flows/a.spec.ts › geo › stubs the chips", "fail", true, "flows/a.spec.ts"],
    ["flows/a.spec.ts › never ran", "fail", true, "flows/a.spec.ts"],
  ]);
  assert.match(judged.refused[0]!.detail ?? "", /intercepts requests/);
  assert.equal(verdictAfterRefusal("pass", judged), "fail", "a run that passed over an intercepting test has not passed");
});

test("a refused interception counts toward no mode and proves nothing for its file", () => {
  const judged = refuseOutright({ cases: [caseOf("flows/a.spec.ts", "stubs")], interceptedTests: [{ file: "flows/a.spec.ts", name: "stubs" }] }, ["flows/a.spec.ts"]);
  const all = [...judged.cases, ...judged.refused];
  assert.deepEqual(tallyOf("flows/a.spec.ts", { cases: all }), { ran: 0, passing: 0, expectedFailures: 0, skipped: 0 });
  assert.equal(hasProof("flows/a.spec.ts", all), false);
});

test("a regeneration is refused for every intercepting test its changed files still hold, whatever the run before had", () => {
  const prior = { cases: [caseOf("flows/a.spec.ts", "stubs")], interceptedTests: [{ file: "flows/a.spec.ts", name: "stubs" }] };
  const now = { cases: [caseOf("flows/a.spec.ts", "stubs"), caseOf("flows/b.spec.ts", "other")], interceptedTests: [{ file: "flows/a.spec.ts", name: "stubs" }, { file: "flows/b.spec.ts", name: "other" }] };
  assert.deepEqual(modeRefusals(["flows/a.spec.ts"], prior, now).map((r) => r.file), ["flows/a.spec.ts"], "an interception already in the prior bytes is not allowed to stay");
  assert.deepEqual(modeRefusals(["flows/c.spec.ts"], prior, now), [], "a file the regeneration did not change is not judged");
  assert.deepEqual(modeRefusals(["flows/a.spec.ts"], prior, { cases: now.cases }), [], "no interception, no refusal");
});
