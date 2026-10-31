/* Behavioral tests for parsePlaywrightReport. QaCase comes from the qa-engine kernel, not
   src/persistence/types.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

/* Reports Playwright 1.60.0 wrote for real specs (see __fixtures__/playwright-1.60.0): the shapes a rule about skipped, expected-to-fail and never-run tests must read, not shapes invented to fit it. */
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./__fixtures__/playwright-1.60.0/${name}.json`, import.meta.url), "utf8"));

test("real report: every form of a declared skip is a skipped test with its annotation, and none of them is a case", () => {
  const parsed = parsePlaywrightReport(fixture("main"));
  const skipped = parsed.skippedTests.map((t) => `${t.file} › ${t.name.split(" › ").slice(1).join(" › ")}:${t.annotation}`);
  for (const declared of ["static skip:skip", "conditional skip true in body:skip", "static fixme:fixme", "fixme in body:fixme", "testInfo.skip():skip", "test.info().skip():skip", "alias skip:skip"]) {
    assert.ok(skipped.some((s) => s.endsWith(`› ${declared}`)), declared);
  }
  assert.ok(parsed.skippedTests.some((t) => t.name.endsWith("in skipped modifier group")), "a skipped describe group");
  assert.equal(parsed.cases.some((c) => /static skip|static fixme|alias skip/.test(c.name)), false);
});

test("real report: a test skipped after a failing attempt is a declared skip, not a flaky case", () => {
  const parsed = parsePlaywrightReport(fixture("main"));
  assert.ok(parsed.skippedTests.some((t) => t.name.endsWith("skip after a failing assertion attempt")));
  assert.equal(parsed.cases.some((c) => c.name.endsWith("skip after a failing assertion attempt")), false);
});

test("real report: a conditional skip whose condition is false ran and is an ordinary case", () => {
  const parsed = parsePlaywrightReport(fixture("main"));
  const ran = parsed.cases.find((c) => c.name.endsWith("conditional skip false in body"));
  assert.deepEqual([ran?.status, ran?.expectedStatus], ["pass", "passed"]);
});

test("real report: test.fail() forms are cases that declared failed, and an unexpected pass of one is a failure", () => {
  const parsed = parsePlaywrightReport(fixture("main"));
  const byName = (end: string) => parsed.cases.find((c) => c.name.endsWith(end));
  assert.deepEqual([byName("declared fail that fails")?.status, byName("declared fail that fails")?.expectedStatus], ["pass", "failed"]);
  assert.deepEqual([byName("fail in body that fails")?.status, byName("fail in body that fails")?.expectedStatus], ["pass", "failed"]);
  assert.deepEqual([byName("testInfo.fail() in body that fails")?.status, byName("testInfo.fail() in body that fails")?.expectedStatus], ["pass", "failed"]);
  assert.deepEqual([byName("declared fail that passes")?.status, byName("declared fail that passes")?.expectedStatus], ["fail", "failed"]);
});

test("real report: tests that did not run because an earlier one failed are neither cases nor declared skips, and the failing one keeps its mode", () => {
  const parsed = parsePlaywrightReport(fixture("serial-retries-2"));
  assert.deepEqual(parsed.skippedTests, [], "a test that never ran was not skipped by its author");
  const serial = parsed.cases.filter((c) => c.name.startsWith("flows/serial.spec.ts"));
  assert.deepEqual(serial.map((c) => [c.name.split(" › ")[1], c.status, c.expectedStatus]), [["step 1 opens the cart", "pass", "passed"], ["step 2 adds an item", "fail", "passed"]]);
  const hook = parsed.cases.filter((c) => c.name.startsWith("flows/beforeall.spec.ts")).map((c) => [c.status, c.expectedStatus]);
  assert.deepEqual(hook, [["pass", "passed"], ["fail", "passed"]], "tests under a failing beforeAll did not run either");
  assert.equal(parsed.verdict, "fail");
});

test("real report: a project listed twice reports its skip and its test.fail() once per spec, whatever the project", () => {
  const parsed = parsePlaywrightReport(fixture("two-projects"));
  assert.equal(parsed.skippedTests.filter((t) => t.name.endsWith("static skip")).length, 1);
  assert.deepEqual(parsed.cases.filter((c) => c.name.endsWith("known app bug")).map((c) => c.expectedStatus), ["failed"]);
});

test("real report: with a testDir the case's file is the suite-relative path, whichever way the run's directory is spelled", () => {
  /* testDir './flows' makes the top suite's title relative to the flows directory; the delivered spec is `flows/plain.spec.ts`. */
  for (const specRoots of [["/work/e2e"], ["/var/elsewhere/e2e", "/work/e2e"]]) {
    const parsed = parsePlaywrightReport(fixture("testdir-flows"), { specRoots });
    assert.deepEqual([...new Set(parsed.cases.map((c) => c.file))].sort(), ["flows/only-fail.spec.ts", "flows/plain.spec.ts"]);
    assert.ok(parsed.cases.every((c) => c.name.startsWith("plain.spec.ts") || c.name.startsWith("only-fail.spec.ts")), "the case's name keeps the report's own spelling");
  }
});

test("real report: a report whose directory is not one of the run's keeps the file as the report spelled it", () => {
  const parsed = parsePlaywrightReport(fixture("testdir-flows"), { specRoots: ["/somewhere/else"] });
  assert.deepEqual([...new Set(parsed.cases.map((c) => c.file))].sort(), ["only-fail.spec.ts", "plain.spec.ts"]);
});

test("a case carries the time its last attempt took, the one run that decided it, and none when the report states no time", () => {
  const report = {
    suites: [
      {
        title: "list.spec.ts",
        specs: [
          { title: "steady", tests: [{ status: "expected", results: [{ status: "passed", duration: 2100 }] }] },
          {
            title: "rescued by a retry",
            tests: [{ status: "flaky", results: [{ status: "timedOut", duration: 30000 }, { status: "passed", duration: 4200 }] }],
          },
          { title: "timeless", tests: [{ status: "expected", results: [{ status: "passed" }] }] },
        ],
      },
    ],
  };
  const byTitle = new Map(parsePlaywrightReport(report).cases.map((c) => [c.name.split(" › ").at(-1), c]));
  assert.equal(byTitle.get("steady")?.durationMs, 2100);
  assert.equal(byTitle.get("rescued by a retry")?.durationMs, 4200);
  assert.equal(byTitle.get("timeless")?.durationMs, undefined);
});
