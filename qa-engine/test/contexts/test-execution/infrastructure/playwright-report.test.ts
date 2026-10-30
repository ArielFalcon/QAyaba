/* Behavioral tests for parsePlaywrightReport. QaCase comes from the qa-engine kernel, not
   src/types.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlaywrightReport } from "@contexts/test-execution/infrastructure/playwright-report.ts";
import { LOAD_ERROR_MESSAGE_SAFETY_BOUND } from "@contexts/test-execution/domain/spec-load-error.ts";
import { createRunSecretScope, withRunSecretScope } from "../../../../src/shared-kernel/run-secret-redaction.ts";

test("maps nested specs to pass/fail cases", () => {
  const report = {
    suites: [
      {
        title: "login.spec.ts",
        specs: [
          { title: "logs in with valid credentials", ok: true },
          {
            title: "rejects invalid credentials",
            ok: false,
            tests: [{ results: [{ status: "failed", error: { message: "expected 401" } }] }],
          },
        ],
      },
    ],
  };
  const parsed = parsePlaywrightReport(report);
  assert.equal(parsed.cases.length, 2);
  assert.equal(parsed.passed, false);
  const failed = parsed.cases.find((c) => c.status === "fail");
  assert.match(failed!.name, /rejects invalid/);
  assert.equal(failed!.detail, "expected 401");
});

test("all green => passed true", () => {
  const report = {
    suites: [{ title: "s", specs: [{ title: "a", ok: true }, { title: "b", ok: true }] }],
  };
  const parsed = parsePlaywrightReport(report);
  assert.equal(parsed.passed, true);
  assert.equal(parsed.cases.length, 2);
});

test("with no specs uses stats to detect failures (and requires execution to pass)", () => {
  assert.equal(parsePlaywrightReport({ stats: { expected: 2, unexpected: 0 } }).passed, true);
  assert.equal(parsePlaywrightReport({ stats: { expected: 0, unexpected: 2 } }).passed, false);
});

test("marks flaky when a test passed after a retry (status flaky)", () => {
  const report = {
    suites: [
      {
        title: "checkout.spec.ts",
        specs: [
          { title: "stable", tests: [{ status: "expected" }] },
          { title: "unstable", tests: [{ status: "flaky" }] },
        ],
      },
    ],
  };
  const parsed = parsePlaywrightReport(report);
  assert.equal(parsed.verdict, "flaky"); /* no fail, but there is a flaky */
  assert.equal(parsed.passed, false);
  assert.equal(parsed.cases.find((c) => c.status === "flaky")?.name.includes("unstable"), true);
});

test("a consistent fail wins over a flaky", () => {
  const report = {
    suites: [
      {
        specs: [
          { title: "a", tests: [{ status: "flaky" }] },
          { title: "b", tests: [{ status: "unexpected", results: [{ error: { message: "boom" } }] }] },
        ],
      },
    ],
  };
  assert.equal(parsePlaywrightReport(report).verdict, "fail");
});

test("derives ok from results when there is no spec.ok", () => {
  const report = {
    suites: [
      {
        specs: [{ title: "c", tests: [{ results: [{ status: "passed" }] }] }],
      },
    ],
  };
  assert.equal(parsePlaywrightReport(report).passed, true);
});

/* Filter C invariant (the inverse of "no parseable report => infra-error"): a
   report that PARSED but executed ZERO tests must NEVER classify as pass. A
   suite that ran nothing proves nothing and must not publish a green PR.
 */
test("a report that executed zero tests is never a pass", () => {
  assert.equal(parsePlaywrightReport({ suites: [] }).passed, false);
  assert.equal(parsePlaywrightReport({ suites: [] }).verdict, "infra-error");
  assert.equal(parsePlaywrightReport({}).passed, false);
});

test("a spec whose tests are all skipped does not count as a pass", () => {
  const report = { suites: [{ specs: [{ title: "skipped one", tests: [{ status: "skipped" }] }] }] };
  const parsed = parsePlaywrightReport(report);
  assert.equal(parsed.passed, false);
  assert.equal(parsed.cases.some((c) => c.status === "pass"), false);
});

test("an unrecognized per-test status fails closed, never a silent pass", () => {
  const report = { suites: [{ specs: [{ title: "timed out", tests: [{ status: "timedOut" }] }] }] };
  assert.equal(parsePlaywrightReport(report).passed, false);
});

test("stats-only report passes only when tests actually executed", () => {
  assert.equal(parsePlaywrightReport({ stats: { expected: 3, unexpected: 0, flaky: 0, skipped: 0 } }).passed, true);
  assert.equal(parsePlaywrightReport({ stats: { expected: 1, unexpected: 2 } }).passed, false);
});

test("the tests the report says were skipped are carried with their file, and are not cases", () => {
  const report = {
    suites: [
      { title: "flows/a.spec.ts", specs: [{ title: "ran", tests: [{ status: "expected" }] }, { title: "fixme", tests: [{ status: "skipped" }] }] },
      { title: "flows/b.spec.ts", specs: [{ title: "needs a seeded account", tests: [{ status: "skipped" }] }] },
    ],
  };
  const parsed = parsePlaywrightReport(report);
  assert.deepEqual(parsed.cases.map((c) => c.name), ["flows/a.spec.ts › ran"]);
  assert.deepEqual(parsed.skippedTests, [
    { name: "flows/a.spec.ts › fixme", file: "flows/a.spec.ts" },
    { name: "flows/b.spec.ts › needs a seeded account", file: "flows/b.spec.ts" },
  ]);
});

test("a spec with one executed pass and one skipped test still passes", () => {
  const report = { suites: [{ specs: [{ title: "mixed", tests: [{ status: "expected" }, { status: "skipped" }] }] }] };
  assert.equal(parsePlaywrightReport(report).passed, true);
});

test("parsePlaywrightReport: a parsed QaCase carries the spec file basename from the enclosing suite title", () => {
  const report = {
    suites: [
      {
        title: "login.spec.ts",
        specs: [
          { title: "logs in", ok: true },
          { title: "rejects bad pw", ok: false, tests: [{ results: [{ status: "failed", error: { message: "401" } }] }] },
        ],
      },
    ],
  };
  const parsed = parsePlaywrightReport(report);
  /* Both cases must carry the enclosing suite title as .file */
  for (const c of parsed.cases) {
    assert.equal((c as import("@kernel/qa-case.ts").QaCase).file, "login.spec.ts", `expected file="login.spec.ts" on case "${c.name}", got ${JSON.stringify((c as import("@kernel/qa-case.ts").QaCase).file)}`);
  }
});

test("parsePlaywrightReport: nested suite (describe block) — file is still the TOP-LEVEL suite title", () => {
  const report = {
    suites: [
      {
        title: "checkout.spec.ts",
        suites: [
          {
            title: "Checkout flow",
            specs: [{ title: "completes order", ok: true }],
          },
        ],
      },
    ],
  };
  const parsed = parsePlaywrightReport(report);
  assert.equal(parsed.cases.length, 1);
  assert.equal((parsed.cases[0]! as import("@kernel/qa-case.ts").QaCase).file, "checkout.spec.ts");
});

test("parsePlaywrightReport: a spec at the root suite (no file title) leaves file undefined", () => {
  /* When there is no enclosing suite that looks like a spec file, file stays undefined. */
  const report = {
    suites: [
      {
        specs: [{ title: "orphan test", ok: true }],
      },
    ],
  };
  const parsed = parsePlaywrightReport(report);
  assert.equal(parsed.cases.length, 1);
  /* file is either undefined or empty — must NOT be a meaningful path */
  const file = (parsed.cases[0]! as import("@kernel/qa-case.ts").QaCase).file;
  assert.ok(!file || file === "", `orphan test should have no meaningful file; got ${JSON.stringify(file)}`);
});

test("reads the report's top-level errors with their place, and leaves out what is not a message", () => {
  const parsed = parsePlaywrightReport({
    suites: [],
    errors: [
      { message: "Error: Cannot find module './x'", location: { file: "/w/e2e/flows/a.spec.ts", line: 4, column: 1 } },
      { message: "Error: no place" },
      { message: "" },
      { location: { file: "/w/e2e/b.spec.ts" } },
      "not an object",
      null,
    ],
    stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
  });
  assert.equal(parsed.executed, 0);
  assert.equal(parsed.loadErrors.length, 2);
  const [located, bare] = parsed.loadErrors;
  assert.match(located!.message, /Cannot find module/);
  assert.deepEqual(located!.location, { file: "/w/e2e/flows/a.spec.ts", line: 4, column: 1 });
  assert.equal(bare!.location, undefined);
});

test("a run secret of several words straddling the bound of a load error's message leaves no word of itself", () => {
  const passphrase = "tangerine staple orbit nine";
  const words = "SyntaxError: unexpected token near the cart total ";
  const message = `${words.repeat(Math.ceil(LOAD_ERROR_MESSAGE_SAFETY_BOUND / words.length)).slice(0, LOAD_ERROR_MESSAGE_SAFETY_BOUND - 16)}${passphrase} and more`;
  const scope = createRunSecretScope();
  scope.addAccountSecrets([passphrase]);
  const parsed = withRunSecretScope(scope, () => parsePlaywrightReport({ suites: [], errors: [{ message }], stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 } }));
  assert.equal(parsed.loadErrors.length, 1);
  assert.ok(!/tangerine|staple/.test(parsed.loadErrors[0]!.message));
});

test("a report without top-level errors, or with errors that are not a list, has no load errors", () => {
  assert.deepEqual(parsePlaywrightReport({ suites: [] }).loadErrors, []);
  assert.deepEqual(parsePlaywrightReport({ suites: [], errors: "boom" }).loadErrors, []);
});

test("a skipped test carries the type of the annotation that skipped it, and one skipped by a condition alone carries none", () => {
  const report = {
    suites: [
      {
        title: "flows/a.spec.ts",
        specs: [
          { title: "fixme", tests: [{ status: "skipped", annotations: [{ type: "fixme" }] }] },
          { title: "skip", tests: [{ status: "skipped", annotations: [{ type: "skip", description: "why" }] }] },
          { title: "info skip", tests: [{ status: "skipped", annotations: [{ type: "slow" }] }] },
        ],
      },
    ],
  };
  assert.deepEqual(parsePlaywrightReport(report).skippedTests, [
    { name: "flows/a.spec.ts › fixme", file: "flows/a.spec.ts", annotation: "fixme" },
    { name: "flows/a.spec.ts › skip", file: "flows/a.spec.ts", annotation: "skip" },
    { name: "flows/a.spec.ts › info skip", file: "flows/a.spec.ts" },
  ]);
});

test("a test that runs with expectedStatus failed is still a case, and is carried as an expected failure", () => {
  const report = {
    suites: [
      {
        title: "flows/a.spec.ts",
        specs: [
          { title: "ran", tests: [{ status: "expected", expectedStatus: "passed" }] },
          { title: "marked to fail", tests: [{ status: "expected", expectedStatus: "failed" }] },
        ],
      },
    ],
  };
  const parsed = parsePlaywrightReport(report);
  assert.deepEqual(parsed.cases.map((c) => [c.name, c.status]), [["flows/a.spec.ts › ran", "pass"], ["flows/a.spec.ts › marked to fail", "pass"]]);
  assert.deepEqual(parsed.expectedFailures, [{ name: "flows/a.spec.ts › marked to fail", file: "flows/a.spec.ts" }]);
});

test("every case carries the status its test declared: passed by default, failed for test.fail(), none when the report states none", () => {
  const report = {
    suites: [
      {
        title: "flows/a.spec.ts",
        specs: [
          { title: "ran", tests: [{ status: "expected", expectedStatus: "passed" }] },
          { title: "marked to fail", tests: [{ status: "expected", expectedStatus: "failed" }] },
          { title: "marked to fail and passing", tests: [{ status: "unexpected", expectedStatus: "failed" }] },
          { title: "no declaration", tests: [{ status: "expected" }] },
        ],
      },
    ],
  };
  const parsed = parsePlaywrightReport(report);
  assert.deepEqual(
    parsed.cases.map((c) => [c.name, c.status, c.expectedStatus]),
    [
      ["flows/a.spec.ts › ran", "pass", "passed"],
      ["flows/a.spec.ts › marked to fail", "pass", "failed"],
      ["flows/a.spec.ts › marked to fail and passing", "fail", "failed"],
      ["flows/a.spec.ts › no declaration", "pass", undefined],
    ],
  );
});
