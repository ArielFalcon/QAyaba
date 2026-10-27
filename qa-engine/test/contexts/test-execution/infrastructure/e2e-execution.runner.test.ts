/* Behavioral tests for the e2e-mode runner/parser/harvest body.
   1. `ExecuteDeps` is `E2eExecuteDeps` in this home.
   2. The real-spawn "killTree SIGKILLs a detached child" integration test lives with
   ProcessKillAdapter (qa-engine/test/shared-infrastructure/process-sandbox/process-kill.test.ts).
   3. `e2eTimeoutMs` is a pure function taking `env` as an explicit parameter (same as
   sandbox.ts's resolveSandbox(env, ...)) instead of mutating process.env — no global env
   mutation / try-finally needed.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  runE2E,
  type E2eExecuteDeps,
  parseStreamEvent,
  streamStatusToCase,
  allFailuresAreRunnerInfra,
  playwrightArgs,
  specListContent,
  e2eTimeoutMs,
  DEFAULT_E2E_TIMEOUT_MS,
  matchFailureDumps,
  segmentsAreTail,
  readFailureDumps,
  createDefaultE2eCleanupDeps,
  createDefaultE2eExecuteDeps,
  E2E_STDERR_KEEP_CHARS,
  MAX_STREAM_EVENT_LINE_CHARS,
  type StreamEvent,
  type FailureDump,
} from "@contexts/test-execution/infrastructure/e2e-execution.runner.ts";
import { sharedTestExec, testExecSandbox } from "../../../support/exec-sandbox-harness.ts";
import { ProcessKillAdapter } from "../../../../src/shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import { newSandboxReport, withExecScope, type RunScope } from "../../../../src/shared-infrastructure/process-sandbox/exec-scope.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { MAX_DEV_WRITE_REQUESTS } from "@contexts/test-execution/domain/dev-write-request.ts";

test("allFailuresAreRunnerInfra: a browser-launch failure is infra (runner fault), not a test failure", () => {
  const launchFail: QaCase[] = [
    { name: "owner-registration.spec.ts › register owner", status: "fail", detail: "Error: browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium_headless_shell-1155/chrome-linux/headless_shell" },
    { name: "cleanup.spec.ts › cleanup", status: "fail", detail: "Error: browserType.launch: Executable doesn't exist" },
  ];
  assert.equal(allFailuresAreRunnerInfra(launchFail), true);

  /* A GENUINE test failure (assertion/timeout) is NOT infra — it stays `fail`. */
  const realFail: QaCase[] = [
    { name: "owner › appears in list", status: "fail", detail: "Error: expect(locator).toBeVisible() failed: timed out" },
  ];
  assert.equal(allFailuresAreRunnerInfra(realFail), false);

  /* A MIX (one infra, one genuine) is conservatively NOT reclassified — stays `fail`. */
  const mixed: QaCase[] = [launchFail[0]!, realFail[0]!];
  assert.equal(allFailuresAreRunnerInfra(mixed), false);

  /* No failures at all → not infra. */
  assert.equal(allFailuresAreRunnerInfra([{ name: "x", status: "pass" }]), false);

  /* A "Target page/context/browser closed" failure is NOT runner infra: the app crashing the tab
     is a real defect the test SHOULD surface. It must stay `fail`, never be hidden as infra-error.
   */
  const tabCrash: QaCase[] = [
    { name: "checkout › completes", status: "fail", detail: "Error: Target page has been closed" },
  ];
  assert.equal(allFailuresAreRunnerInfra(tabCrash), false);
});

test("runs, maps cases and SANITIZES the logs", async () => {
  const deps: E2eExecuteDeps = {
    runSuite: async () => ({
      report: {
        suites: [
          {
            title: "login.spec.ts",
            specs: [
              { title: "ok", ok: true },
              {
                title: "broken",
                ok: false,
                tests: [{ results: [{ status: "failed", error: { message: "boom" } }] }],
              },
            ],
          },
        ],
      },
      /* a log with a secret that must NOT reach the LLM/Issue */
      logs: "running... token: ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa end",
      ran: true,
    }),
  };

  const run = await runE2E("/mirrors/org__app/e2e", { baseUrl: "https://dev", namespace: "qa-bot-abc1234" }, deps);

  assert.equal(run.verdict, "fail");
  assert.equal(run.passed, false);
  assert.equal(run.cases.length, 2);
  assert.doesNotMatch(run.logs, /ghs_aaaa/); /* secret redacted */
  assert.match(run.logs, /\[REDACTED\]/);
});

test("classifies flaky when there are unstable cases and none fail", async () => {
  const deps: E2eExecuteDeps = {
    runSuite: async () => ({
      report: { suites: [{ specs: [{ title: "x", tests: [{ status: "flaky" }] }] }] },
      logs: "ok",
      ran: true,
    }),
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-f" }, deps);
  assert.equal(run.verdict, "flaky");
  assert.equal(run.passed, false);
});

test("all green => verdict pass", async () => {
  const deps: E2eExecuteDeps = {
    runSuite: async () => ({ report: { stats: { expected: 2, unexpected: 0 } }, logs: "ok", ran: true }),
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-zzz" }, deps);
  assert.equal(run.passed, true);
  assert.equal(run.verdict, "pass");
});

test("a crashed runner (no parseable report) is infra-error, NEVER pass", async () => {
  /* The default runner sets ran:false when stdout is not JSON (Playwright failed
     to launch / config error). This must not be swallowed into a green run.
   */
  const deps: E2eExecuteDeps = {
    runSuite: async () => ({ report: {}, logs: "Error: browserType.launch failed", ran: false }),
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-crash" }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
  assert.equal(run.cases.length, 0);
});

test("a ran-but-empty report ({}) is infra-error, not a false pass", async () => {
  const deps: E2eExecuteDeps = {
    runSuite: async () => ({ report: {}, logs: "weird", ran: true }),
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-empty" }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
});

test("parseStreamEvent parses the NDJSON reporter lines and ignores noise", () => {
  assert.deepEqual(parseStreamEvent('{"e":"begin","total":3}'), { phase: "begin", total: 3 });
  assert.deepEqual(parseStreamEvent('{"e":"discovered","title":"checkout › buys","file":"c.spec.ts"}'), { phase: "discovered", title: "checkout › buys", file: "c.spec.ts" });
  assert.deepEqual(parseStreamEvent('{"e":"testbegin","title":"checkout › buys","file":"c.spec.ts"}'), { phase: "testbegin", title: "checkout › buys", file: "c.spec.ts" });
  assert.deepEqual(parseStreamEvent('{"e":"testend","title":"checkout › buys","status":"passed"}'), { phase: "testend", title: "checkout › buys", status: "passed" });
  assert.equal(parseStreamEvent(""), null);
  assert.equal(parseStreamEvent("not json"), null);
  assert.equal(parseStreamEvent('{"e":"other"}'), null);
});

test("streamStatusToCase maps green to pass, skipped to null, everything else fail-closed", () => {
  assert.equal(streamStatusToCase("passed"), "pass");
  assert.equal(streamStatusToCase("expected"), "pass");
  assert.equal(streamStatusToCase("skipped"), null);
  assert.equal(streamStatusToCase("failed"), "fail");
  assert.equal(streamStatusToCase("timedOut"), "fail");
});

test("runE2E streams testbegin → onRunning and testend → onCase incrementally", async () => {
  const running: string[] = [];
  const cases: QaCase[] = [];
  const deps: E2eExecuteDeps = {
    runSuite: async ({ onEvent }) => {
      onEvent?.({ phase: "begin", total: 2 });
      onEvent?.({ phase: "testbegin", title: "home › hero" });
      onEvent?.({ phase: "testend", title: "home › hero", status: "passed" });
      onEvent?.({ phase: "testbegin", title: "cart › total" });
      onEvent?.({ phase: "testend", title: "cart › total", status: "failed" });
      onEvent?.({ phase: "testend", title: "skip › me", status: "skipped" }); /* not a case */
      return { report: { stats: { expected: 1, unexpected: 1 } }, logs: "ok", ran: true };
    },
  };
  await runE2E("/dir", {
    baseUrl: "https://dev",
    namespace: "qa-bot-stream",
    onRunning: (t) => running.push(t),
    onCase: (c) => cases.push(c),
  }, deps);

  assert.deepEqual(running, ["home › hero", "cart › total"]);
  assert.deepEqual(cases.map((c) => `${c.name}:${c.status}`), ["home › hero:pass", "cart › total:fail"]);
});

test("a ran report that executed zero tests is infra-error, not a false pass", async () => {
  /* A shaped report (suites present) but with no executed test — e.g. testMatch
     matched nothing, or every spec was filtered/skipped. Ran, but proved nothing.
   */
  const deps: E2eExecuteDeps = {
    runSuite: async () => ({ report: { suites: [], stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 } }, logs: "Error: No tests found", ran: true }),
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-zero" }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
});

test("runE2E propagates error when deps.runSuite throws (runner crash / spawn error)", async () => {
  const deps: E2eExecuteDeps = {
    runSuite: async () => { throw new Error("Playwright runner crashed: spawn ENOENT"); },
  };
  await assert.rejects(
    () => runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-crash" }, deps),
    /spawn ENOENT/,
  );
});

/* The temp failureCaptureDir must be removed even when deps.runSuite REJECTS. Capture the dir
   runE2E handed the runner, then reject; after the rejection the dir must NOT exist on disk.
 */
test("runE2E removes the temp failureCaptureDir on the runSuite REJECT path (no leak)", async () => {
  const { existsSync } = await import("node:fs");
  let handedDir: string | undefined;
  const deps: E2eExecuteDeps = {
    runSuite: async (args) => {
      handedDir = args.failureCaptureDir;
      /* The dir must exist while the runner holds it (the fixture writes into it). */
      assert.ok(handedDir && existsSync(handedDir), "failureCaptureDir should exist while the runner runs");
      throw new Error("Playwright runner crashed: spawn ENOENT");
    },
  };
  await assert.rejects(
    () => runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-leak" }, deps),
    /spawn ENOENT/,
  );
  assert.ok(handedDir, "the runner should have been handed a failureCaptureDir");
  assert.equal(existsSync(handedDir!), false, "the temp failureCaptureDir must be removed on the reject path");
});

test("runE2E handles a malformed report shape by returning infra-error", async () => {
  const deps: E2eExecuteDeps = {
    runSuite: async () => ({ report: { notSuites: "x" }, logs: "weird output", ran: true }),
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-malformed" }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
});

test("runE2E handles a null report by returning infra-error", async () => {
  const deps: E2eExecuteDeps = {
    runSuite: async () => ({ report: null, logs: "null report", ran: true }),
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-null" }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
});

/* The per-case harvest's loud "no grounding" WARNING must fire even when failureCaptureDir is
   UNDEFINED (mkdtempSync failed, e.g. no /tmp space) — the fixture dump is the ONLY source of
   failureDom (Playwright's JSON reporter carries no per-error DOM snapshot), so a failed case with
   no capture dir at all has nothing to fall back to and must warn rather than swallow the gap.
   Force mkdtempSync to throw by pointing TMPDIR at a non-existent path.
 */
test("the no-grounding WARNING still fires when the capture dir can't be minted", async () => {
  const deps: E2eExecuteDeps = {
    runSuite: async (args) => {
      /* The dir could not be minted, so the runner is handed no capture dir at all. */
      assert.equal(args.failureCaptureDir, undefined, "failureCaptureDir must be undefined when mkdtempSync throws");
      return {
        report: {
          suites: [
            {
              title: "owners.spec.ts",
              specs: [
                {
                  title: "has nothing",
                  ok: false,
                  tests: [{ status: "unexpected", results: [{ status: "failed", error: { message: "expect(received).toHaveText(expected) failed" } }] }],
                },
              ],
            },
          ],
        },
        logs: "ok",
        ran: true,
      };
    },
  };

  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
  const prevTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  const bogus = join(tmpdir(), `definitely-missing-${Date.now()}`, "nope");
  process.env.TMPDIR = bogus; process.env.TMP = bogus; process.env.TEMP = bogus;
  let run;
  try {
    run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-w2" }, deps);
  } finally {
    console.warn = realWarn;
    for (const [k, v] of Object.entries(prevTmp)) { if (v === undefined) delete (process.env as Record<string, string | undefined>)[k]; else (process.env as Record<string, string>)[k] = v; }
  }

  assert.equal(run.verdict, "fail");
  const failed = run.cases.find((c) => c.name.endsWith("has nothing"));
  assert.ok(failed, "the failing case should be present");
  assert.equal(failed!.failureDom, undefined, "no dump and no capture dir -> no failureDom, never fabricated");
  /* The case with no dump still triggers the loud WARNING (never swallowed). */
  assert.ok(
    warnings.some((w) => /no failure-point DOM captured/i.test(w) && /has nothing/.test(w)),
    `expected a 'no failure-point DOM captured' WARNING for the empty case; warnings: ${JSON.stringify(warnings)}`,
  );
});

test("a hung runner is timed out and classified infra-error, never a test failure", async () => {
  const deps: E2eExecuteDeps = {
    runSuite: () => new Promise(() => { /* hangs forever, like a wedged browser */ }),
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-hang", timeoutMs: 30 }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
  assert.equal(run.cases.length, 0);
  assert.match(run.logs, /timed out after 30ms — killed/);
});

test("an abort signal kills a hung runner and classifies infra-error", async () => {
  const controller = new AbortController();
  const deps: E2eExecuteDeps = {
    runSuite: () => new Promise(() => {  }),
  };
  setTimeout(() => controller.abort(), 10);
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-abort", signal: controller.signal }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
  assert.match(run.logs, /aborted by operator cancel/);
});

test("an already-aborted signal returns infra-error without starting the runner", async () => {
  const controller = new AbortController();
  controller.abort();
  let started = false;
  const deps: E2eExecuteDeps = {
    runSuite: async () => { started = true; return { report: { stats: {} }, logs: "", ran: true }; },
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-preabort", signal: controller.signal }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(started, false);
});

test("runE2E passes project, signal and timeoutMs through to the runner deps", async () => {
  const controller = new AbortController();
  let seen: { project?: string; signal?: AbortSignal; timeoutMs?: number } = {};
  const deps: E2eExecuteDeps = {
    runSuite: async (args) => {
      seen = { project: args.project, signal: args.signal, timeoutMs: args.timeoutMs };
      return { report: { stats: { expected: 1 } }, logs: "ok", ran: true };
    },
  };
  await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-proj", project: "desktop", signal: controller.signal, timeoutMs: 5_000 }, deps);
  assert.equal(seen.project, "desktop");
  assert.equal(seen.signal, controller.signal);
  assert.equal(seen.timeoutMs, 5_000);
});

/* testIdAttribute must reach deps.runSuite — apps declare their test-id convention in config
   (e.g. data-cy for jhipster) and the DOM capture / selector catalog / authoring contract all
   validate against it, but the VERDICTUAL Playwright run never received it, so PW_TEST_ID_ATTRIBUTE
   was never set and getByTestId silently resolved the default data-testid on non-default apps.
 */
test("runE2E passes testIdAttribute through to the runner deps", async () => {
  let seen: { testIdAttribute?: string } = {};
  const deps: E2eExecuteDeps = {
    runSuite: async (args) => {
      seen = { testIdAttribute: args.testIdAttribute };
      return { report: { stats: { expected: 1 } }, logs: "ok", ran: true };
    },
  };
  await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns", testIdAttribute: "data-cy" }, deps);
  assert.equal(seen.testIdAttribute, "data-cy");
});

test("runE2E hands the mutation pass's mutant to the runner, and none to a run that has none", async () => {
  const seen: Array<string | undefined> = [];
  const deps: E2eExecuteDeps = {
    runSuite: async (args) => {
      seen.push(args.mutant);
      return { report: { stats: { expected: 1 } }, logs: "ok", ran: true };
    },
  };
  const mutant = JSON.stringify({ url: "https://dev/main.js", sha256: "h", start: 1, end: 2, replacement: "!" });
  await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns-mut0", mutant }, deps);
  await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns" }, deps);
  assert.deepEqual(seen, [mutant, undefined]);
});

test("runE2E rejects a project name outside the allowlist (arg-injection surface)", async () => {
  let started = false;
  const deps: E2eExecuteDeps = {
    runSuite: async () => { started = true; return { report: { stats: {} }, logs: "", ran: true }; },
  };
  await assert.rejects(
    () => runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-inj", project: "desktop --workers=99" }, deps),
    /invalid Playwright project name/,
  );
  await assert.rejects(
    () => runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-inj2", project: "a;rm -rf /" }, deps),
    /invalid Playwright project name/,
  );
  assert.equal(started, false);
});

/* The repo owns its playwright.config.ts: its projects may be named anything and a suite run must
   execute all of them unless the caller explicitly configures one. The argv is the one the real
   runner spawns, built from what runE2E hands to runSuite. */
async function suiteArgv(opts: { project?: string }): Promise<string[]> {
  let argv: string[] = [];
  const deps: E2eExecuteDeps = {
    runSuite: async (args) => {
      argv = playwrightArgs("/tmp/rep.cjs", args.project);
      return { report: { stats: { expected: 1 } }, logs: "ok", ran: true };
    },
  };
  await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-projects", ...opts }, deps);
  return argv;
}

test("a suite run with no configured project selects no Playwright project, so every project in the repo config runs", async () => {
  const argv = await suiteArgv({});
  assert.equal(argv.some((a) => a.startsWith("--project")), false, `no --project flag expected, got ${JSON.stringify(argv)}`);
});

test("a suite run with a configured project selects exactly that project", async () => {
  const argv = await suiteArgv({ project: "chromium-tablet" });
  assert.deepEqual(argv.filter((a) => a.startsWith("--project")), ["--project=chromium-tablet"]);
});

test("playwrightArgs appends --project only when set, and validates it", () => {
  assert.deepEqual(playwrightArgs("/tmp/rep.cjs"), ["playwright", "test", "--reporter=/tmp/rep.cjs,json"]);
  assert.deepEqual(
    playwrightArgs("/tmp/rep.cjs", "desktop"),
    ["playwright", "test", "--reporter=/tmp/rep.cjs,json", "--project=desktop"],
  );
  assert.throws(() => playwrightArgs("/tmp/rep.cjs", "desktop mobile"), /invalid Playwright project name/);
  assert.throws(() => playwrightArgs("/tmp/rep.cjs", "$(reboot)"), /invalid Playwright project name/);
});

test("e2eTimeoutMs honors env.QA_E2E_TIMEOUT_MS and falls back to the default on garbage/absent", () => {
  assert.equal(e2eTimeoutMs({ QA_E2E_TIMEOUT_MS: "123456" }), 123456);
  assert.equal(e2eTimeoutMs({ QA_E2E_TIMEOUT_MS: "not-a-number" }), DEFAULT_E2E_TIMEOUT_MS);
  assert.equal(e2eTimeoutMs({ QA_E2E_TIMEOUT_MS: "-5" }), DEFAULT_E2E_TIMEOUT_MS);
  assert.equal(e2eTimeoutMs({}), DEFAULT_E2E_TIMEOUT_MS);
});

test("matchFailureDumps: a fan-out spec under flows/ matches its basename-keyed dump", () => {
  /* The whole parallel fan-out writes specs to flows/<flow>.spec.ts (specFileForFlow), and
     Playwright names the file suite with the path RELATIVE to rootDir → the case name carries
     `flows/checkout.spec.ts`, while the fixture records only the basename `checkout.spec.ts`.
     The match must accept the basename as the trailing `/<basename>` of a segment.
   */
  const dump: FailureDump = { project: "desktop", file: "checkout.spec.ts", title: "Checkout › applies a discount", retry: 0, yaml: "- button: Pay" };
  const caseName = "desktop › flows/checkout.spec.ts › Checkout › applies a discount";
  assert.equal(matchFailureDumps(caseName, [dump])?.yaml, "- button: Pay");
  /* A different file with a confusable basename must NOT match (no loose suffix). */
  const wrong = "desktop › flows/add-checkout.spec.ts › Checkout › applies a discount";
  assert.equal(matchFailureDumps(wrong, [dump]), null);
});

/* The fixture keys a dump off `testInfo.titlePath.slice(1).join(" › ")` = the describe › test
   chain (NO file prefix), while the JSON report's case name is `file.spec.ts › describe › test`
   (file IS the top suite). The harvest matches the two SEGMENT-WISE: the dump's segments must be
   a contiguous tail of the case's segments. This pairing must match.
 */
test("matchFailureDumps: report-name (with file prefix) matches the fixture's describe›test title", () => {
  const dumpTitle = "owner registration › create owner"; /* what the fixture wrote (titlePath sans project+file) */
  const reportName = "owners.spec.ts › owner registration › create owner"; /* what the JSON report calls the case */
  const dumps: FailureDump[] = [
    { project: "desktop", title: dumpTitle, retry: 0, yaml: "- button \"Submit\"" },
    { project: "desktop", title: "unrelated › other", retry: 0, yaml: "- link \"Home\"" },
  ];
  const match = matchFailureDumps(reportName, dumps);
  assert.ok(match, "the report name should match the fixture's file-prefix-stripped title");
  assert.equal(match!.title, dumpTitle);
  assert.equal(match!.yaml, "- button \"Submit\"");
});

test("matchFailureDumps: prefers the HIGHEST retry within a project (the final attempt's DOM)", () => {
  const title = "my suite › my test";
  const dumps: FailureDump[] = [
    { project: "desktop", title, retry: 0, yaml: "y0" },
    { project: "desktop", title, retry: 2, yaml: "y2" },
    { project: "desktop", title, retry: 1, yaml: "y1" },
  ];
  const match = matchFailureDumps("a.spec.ts › my suite › my test", dumps);
  assert.equal(match!.retry, 2, "the last attempt's dump is the one the next round must fix");
  assert.equal(match!.yaml, "y2");
});

/* Two PROJECT dumps for ONE spec (desktop + mobile run every spec) must NOT clobber — both
   survive into the parsed list and the match is DETERMINISTIC (project name asc), never readdir order.
 */
test("matchFailureDumps: two project dumps for one spec do not clobber and resolve deterministically", () => {
  const title = "owner registration › create owner";
  const caseName = "owners.spec.ts › owner registration › create owner";
  const desktop: FailureDump = { project: "desktop", title, retry: 0, yaml: "- button \"Submit\" [desktop]" };
  const mobile: FailureDump = { project: "mobile", title, retry: 0, yaml: "- button \"Submit\" [mobile]" };
  /* Both orderings (readdir is unordered) must yield the SAME pick: project name ascending → desktop. */
  assert.equal(matchFailureDumps(caseName, [desktop, mobile])!.project, "desktop");
  assert.equal(matchFailureDumps(caseName, [mobile, desktop])!.project, "desktop");
});

/* A case "add owner" must NOT match a dump "owner" — suffix matching on slugs would
   cross-match them; segment-wise EXACT-per-segment matching rejects it.
 */
test("matchFailureDumps: case 'add owner' does NOT match a dump 'owner' (no char-suffix cross-match)", () => {
  const dumps: FailureDump[] = [{ project: "desktop", title: "owner", retry: 0, yaml: "y" }];
  assert.equal(matchFailureDumps("owners.spec.ts › add owner", dumps), null);
  const exact: FailureDump[] = [{ project: "desktop", title: "add owner", retry: 0, yaml: "y" }];
  assert.equal(matchFailureDumps("owners.spec.ts › add owner", exact)!.yaml, "y");
});

/* Two titles whose first 80 chars are identical but whose full titles differ must NOT
   cross-match — segment matching uses the FULL title, never a truncated slug.
 */
test("matchFailureDumps: a long title past 80 chars does not collide with another sharing its prefix", () => {
  const prefix = "suite › " + "x".repeat(90); /* > 80 chars before the distinguishing tail */
  const titleA = prefix + " ALPHA";
  const titleB = prefix + " BETA";
  const dumps: FailureDump[] = [
    { project: "desktop", title: titleA, retry: 0, yaml: "yA" },
    { project: "desktop", title: titleB, retry: 0, yaml: "yB" },
  ];
  /* The case for B must select B's dump, never A's (the 80-char prefix is identical). */
  assert.equal(matchFailureDumps("specs.spec.ts › " + titleB, dumps)!.yaml, "yB");
  assert.equal(matchFailureDumps("specs.spec.ts › " + titleA, dumps)!.yaml, "yA");
});

test("matchFailureDumps: returns null when no dump title is a segment-tail of the case", () => {
  const dumps: FailureDump[] = [{ project: "desktop", title: "completely › different", retry: 0 }];
  assert.equal(matchFailureDumps("file.spec.ts › owner › create", dumps), null);
});

test("matchFailureDumps: returns null for an empty dump list", () => {
  assert.equal(matchFailureDumps("any case name", []), null);
});

test("matchFailureDumps: a dump with no title never matches (defensive)", () => {
  const dumps: FailureDump[] = [{ project: "desktop", title: "", retry: 0, yaml: "y" }];
  assert.equal(matchFailureDumps("file.spec.ts › x › y", dumps), null);
});

test("matchFailureDumps: identical title and case name match (no file prefix present)", () => {
  /* Some reporters emit a flat name with no file suffix; the single segment is a reflexive tail. */
  const dumps: FailureDump[] = [{ project: "desktop", title: "flat test name", retry: 0, yaml: "y" }];
  assert.equal(matchFailureDumps("flat test name", dumps)!.yaml, "y");
});

test("segmentsAreTail: exact contiguous tail with per-segment equality", () => {
  assert.equal(segmentsAreTail(["a.spec.ts", "suite", "test"], ["suite", "test"]), true);
  assert.equal(segmentsAreTail(["a.spec.ts", "suite", "test"], ["test"]), true);
  assert.equal(segmentsAreTail(["a.spec.ts", "suite", "test"], ["a.spec.ts", "suite", "test"]), true);
  assert.equal(segmentsAreTail(["a.spec.ts", "suite", "test"], ["suite"]), false);
  assert.equal(segmentsAreTail(["suite", "test"], ["x", "suite", "test"]), false);
  assert.equal(segmentsAreTail(["a", "b"], []), false);
  /* Partial-character segment ("add owner" vs "owner") is rejected — exact per-segment only. */
  assert.equal(segmentsAreTail(["spec", "add owner"], ["owner"]), false);
});

/* The fixture filename `${project}__${hash}__${retry}.json` (hash = sha1 of `${file}/${title}`)
   and body `{ project, file, title, retry, yaml }` must round-trip through readFailureDumps, and
   two projects running the SAME spec must produce TWO distinct files (no clobber).
 */
test("readFailureDumps: two project dumps for one spec are both read (new filename, no clobber)", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-fail-test-"));
  try {
    const title = "owner registration › create owner";
    const file = "owners.spec.ts";
    const hash = createHash("sha1").update(`${file}/${title}`).digest("hex").slice(0, 12);
    /* Exactly what the fixture writes: project-prefixed filename + project/file in the body. */
    writeFileSync(join(dir, `desktop__${hash}__0.json`), JSON.stringify({ project: "desktop", file, title, retry: 0, yaml: "- button \"Submit\"" }));
    writeFileSync(join(dir, `mobile__${hash}__0.json`), JSON.stringify({ project: "mobile", file, title, retry: 0, yaml: "- button \"Submit\"" }));

    const dumps = readFailureDumps(dir);
    assert.equal(dumps.length, 2, "both project dumps must survive (the old shared filename clobbered one)");
    assert.deepEqual([...new Set(dumps.map((d) => d.project))].sort(), ["desktop", "mobile"]);
    assert.ok(dumps.every((d) => d.file === file && d.title === title && d.yaml === "- button \"Submit\""));

    const m = matchFailureDumps("owners.spec.ts › owner registration › create owner", dumps);
    assert.equal(m!.project, "desktop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* Two tests with the SAME `describe › test` chain in DIFFERENT spec files share a `title` —
   only the recorded `file` tells them apart. Fold the file into the dump identity + the match so
   the harvest attaches the right file's DOM. Distinct files (owners.spec.ts, vets.spec.ts) carry
   the identical title but different YAML; each report case must select ITS OWN file's dump.
 */
test("matchFailureDumps: same title in two different files does NOT collide — the right file's DOM attaches", () => {
  const title = "registration › create entity";
  const ownersDump: FailureDump = { project: "desktop", file: "owners.spec.ts", title, retry: 0, yaml: "- button \"Add Owner\"" };
  const vetsDump: FailureDump = { project: "desktop", file: "vets.spec.ts", title, retry: 0, yaml: "- button \"Add Vet\"" };
  const dumps = [ownersDump, vetsDump];

  const ownersMatch = matchFailureDumps(`owners.spec.ts › ${title}`, dumps);
  assert.ok(ownersMatch, "the owners case must match a dump");
  assert.equal(ownersMatch!.yaml, "- button \"Add Owner\"", "owners.spec.ts must attach the OWNERS dump, not vets");

  const vetsMatch = matchFailureDumps(`vets.spec.ts › ${title}`, dumps);
  assert.ok(vetsMatch, "the vets case must match a dump");
  assert.equal(vetsMatch!.yaml, "- button \"Add Vet\"", "vets.spec.ts must attach the VETS dump, not owners");
});

/* Two same-titled, different-file dumps must produce two distinct files (the file is folded
   into the hash) and read back with the right file → right DOM per case.
 */
test("readFailureDumps + match: same title, different files round-trip to distinct files and the right DOM", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-fail-xfile-"));
  try {
    const title = "registration › create entity";
    const ownersHash = createHash("sha1").update(`owners.spec.ts/${title}`).digest("hex").slice(0, 12);
    const vetsHash = createHash("sha1").update(`vets.spec.ts/${title}`).digest("hex").slice(0, 12);
    assert.notEqual(ownersHash, vetsHash, "the file must change the hash so the two dumps land in distinct files");
    writeFileSync(join(dir, `desktop__${ownersHash}__0.json`), JSON.stringify({ project: "desktop", file: "owners.spec.ts", title, retry: 0, yaml: "- button \"Add Owner\"" }));
    writeFileSync(join(dir, `desktop__${vetsHash}__0.json`), JSON.stringify({ project: "desktop", file: "vets.spec.ts", title, retry: 0, yaml: "- button \"Add Vet\"" }));

    const dumps = readFailureDumps(dir);
    assert.equal(dumps.length, 2, "both same-titled dumps must survive on disk (distinct filenames)");
    assert.equal(matchFailureDumps(`owners.spec.ts › ${title}`, dumps)!.yaml, "- button \"Add Owner\"");
    assert.equal(matchFailureDumps(`vets.spec.ts › ${title}`, dumps)!.yaml, "- button \"Add Vet\"");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* A dump with NO recorded file still matches title-only — the file check is skipped when either
   side lacks a file, so older dumps keep working.
 */
test("matchFailureDumps: a dump with no file still matches a file-prefixed case (title-only fallback)", () => {
  const dumps: FailureDump[] = [{ project: "desktop", title: "suite › test", retry: 0, yaml: "y" }];
  assert.equal(matchFailureDumps("older.spec.ts › suite › test", dumps)!.yaml, "y");
});

/* The seed playwright.config defines TWO projects (desktop, mobile) and the suite runs with NO
   --project, so Playwright nests every spec under the PROJECT top-suite → the report case name is
   `desktop › owners.spec.ts › Owners › add owner` (PROJECT leads, FILE is the SECOND segment).
   Matching dump.file only against caseSegs[0] would treat "desktop" as the file and drop every dump.
   Match the dump's file against ANY case segment. The dump's title may be the bare describe›test
   (fixture form) OR include the file — both are a contiguous tail, both must match.
 */
test("matchFailureDumps: PROJECT-FIRST case name (two-project default config) matches the file dump", () => {
  const projectFirst = "desktop › owners.spec.ts › Owners › add owner"; /* project is caseSegs[0], file is caseSegs[1] */
  const bareTitle: FailureDump[] = [{ project: "desktop", file: "owners.spec.ts", title: "Owners › add owner", retry: 0, yaml: "- button \"Submit\"" }];
  const m1 = matchFailureDumps(projectFirst, bareTitle);
  assert.ok(m1, "the dump must MATCH a project-first case name (file is not the leading segment)");
  assert.equal(m1!.yaml, "- button \"Submit\"");
  /* File-prefixed title form must also match (still a contiguous tail of the case segments). */
  const fileTitle: FailureDump[] = [{ project: "desktop", file: "owners.spec.ts", title: "owners.spec.ts › Owners › add owner", retry: 0, yaml: "- button \"Add\"" }];
  assert.equal(matchFailureDumps(projectFirst, fileTitle)!.yaml, "- button \"Add\"");
  /* A WRONG file must still be rejected even though the project segment is present (no cross-file attach). */
  const wrongFile: FailureDump[] = [{ project: "desktop", file: "vets.spec.ts", title: "Owners › add owner", retry: 0, yaml: "y" }];
  assert.equal(matchFailureDumps(projectFirst, wrongFile), null, "a dump for a different file must not match");
});

/* Single project: the SAME helper must keep working when the suite IS run with --project (file leads,
   no project segment) — the case name is `owners.spec.ts › Owners › add owner`. file === caseSegs[0] here.
 */
test("matchFailureDumps: single-project case name (file leads) still matches the file dump", () => {
  const fileFirst = "owners.spec.ts › Owners › add owner";
  const dumps: FailureDump[] = [{ project: "desktop", file: "owners.spec.ts", title: "Owners › add owner", retry: 0, yaml: "- button \"Submit\"" }];
  assert.equal(matchFailureDumps(fileFirst, dumps)!.yaml, "- button \"Submit\"");
});

test("playwrightArgs: a test list is handed over as the one option that selects exact files, never as a positional pattern", () => {
  const args = playwrightArgs("reporter.cjs", undefined, "/work/scripts/abc-spec-list.txt");
  assert.ok(args.includes("--test-list=/work/scripts/abc-spec-list.txt"), `expected the list option in args: ${args.join(" ")}`);
  /* Playwright reads a bare argument as an unanchored, case-insensitive regular expression over the file's whole path. */
  assert.deepEqual(args.filter((a) => !a.startsWith("--")), ["playwright", "test"]);
});

test("playwrightArgs: no test list has the same output as a full-suite run", () => {
  assert.deepEqual(playwrightArgs("reporter.cjs"), playwrightArgs("reporter.cjs", undefined, undefined));
  assert.equal(playwrightArgs("reporter.cjs").some((a) => a.startsWith("--test-list")), false);
});

test("playwrightArgs: a test list path that could pass for an option is refused", () => {
  assert.throws(() => playwrightArgs("reporter.cjs", undefined, "--workers=99"), /invalid test list/);
});

test("specListContent: names each spec on a line of its own, whole and relative to the suite", () => {
  assert.equal(specListContent(["flows/login.spec.ts", "a.spec.ts"]), "flows/login.spec.ts\na.spec.ts\n");
  assert.equal(specListContent([".qa-probe/try.spec.ts"]), ".qa-probe/try.spec.ts\n");
});

test("specListContent: refuses a path that is not one plain relative spec file", () => {
  for (const bad of ["../../../etc/passwd.spec.ts", "flows/../x.spec.ts", "-delete-everything.spec.ts", "login.spec.js", "..spec.ts", ".spec.ts", "flows/..spec.ts", "./a.spec.ts", "a//b.spec.ts", "/abs/a.spec.ts", "a b.spec.ts", "a\nb.spec.ts", "a>b.spec.ts", "a:12.spec.ts", "", "flows/./a.spec.ts"]) {
    assert.throws(() => specListContent([bad]), /invalid spec file/, JSON.stringify(bad));
  }
});

/* ── Harvest fold — finalUrl + httpStatus onto QaCase ─────────────────
   The harvest must fold dump.finalUrl and dump.httpStatus onto the SAME QaCase
   object that today receives failureDom. Asserts the carry-through, the absent-warned path being
   unchanged (failureDom's WARNING is still the only loud one), and best-effort absence.
 */

test("harvest folds dump.finalUrl and dump.httpStatus onto the failed QaCase", async () => {
  /* Write a real capture dump (with finalUrl + httpStatus) into the captureDir that runE2E
     mints and passes to runSuite. The runSuite intercepts the dir, writes the dump into it,
     and returns a report with the matching case. Assert the QaCase carries both fields.
   */
  const title = "owner registration › create owner";
  const file = "owners.spec.ts";
  const hash = createHash("sha1").update(`${file}/${title}`).digest("hex").slice(0, 12);

  const deps: E2eExecuteDeps = {
    runSuite: async (args) => {
      if (args.failureCaptureDir) {
        writeFileSync(
          join(args.failureCaptureDir, `desktop__${hash}__0.json`),
          JSON.stringify({ project: "desktop", file, title, retry: 0, yaml: "- button \"Submit\"", finalUrl: "http://localhost:3000/owners/new", httpStatus: 500 }),
        );
      }
      return {
        report: {
          suites: [{
            title: "owners.spec.ts",
            specs: [{
              title: "owner registration › create owner",
              ok: false,
              tests: [{ results: [{ status: "failed", error: { message: "timeout" } }] }],
            }],
          }],
        },
        logs: "failed",
        ran: true,
      };
    },
  };
  const run = await runE2E("/e2e", { baseUrl: "https://dev", namespace: "desktop" }, deps);
  const failed = run.cases.find((c) => c.status === "fail");
  assert.ok(failed, "the failing case must be present");
  /* The harvest must carry finalUrl and httpStatus on the SAME object. */
  assert.equal((failed as QaCase).httpStatus, 500, "harvest must fold dump.httpStatus onto the QaCase");
  assert.equal((failed as QaCase).finalUrl, "http://localhost:3000/owners/new", "harvest must fold dump.finalUrl onto the QaCase");
});

test("harvest leaves httpStatus/finalUrl absent when dump has neither (absent-warned path unchanged)", async () => {
  /* A dump with only yaml (no finalUrl, no httpStatus) — QaCase must not have them, and the
     only loud WARNING is still the existing failureDom one (no new WARNING introduced).
   */
  const title = "form › submit";
  const file = "form.spec.ts";
  const hash = createHash("sha1").update(`${file}/${title}`).digest("hex").slice(0, 12);

  const deps: E2eExecuteDeps = {
    runSuite: async (args) => {
      if (args.failureCaptureDir) {
        writeFileSync(
          join(args.failureCaptureDir, `desktop__${hash}__0.json`),
          JSON.stringify({ project: "desktop", file, title, retry: 0, yaml: "- button \"Submit\"" }),
        );
      }
      return {
        report: {
          suites: [{ title: "form.spec.ts", specs: [{ title: "form › submit", ok: false, tests: [{ results: [{ status: "failed", error: { message: "timeout" } }] }] }] }],
        },
        logs: "failed",
        ran: true,
      };
    },
  };
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); realWarn(...a); };
  let run;
  try { run = await runE2E("/e2e", { baseUrl: "https://dev", namespace: "desktop" }, deps); }
  finally { console.warn = realWarn; }

  const failed = run.cases.find((c) => c.status === "fail");
  assert.ok(failed);
  assert.equal((failed as QaCase).httpStatus, undefined, "httpStatus must be absent when dump has none");
  assert.equal((failed as QaCase).finalUrl, undefined, "finalUrl must be absent when dump has none");
  /* No new WARNING for absent httpStatus/finalUrl (only failureDom has the loud warning path). */
  const newWarnings = warnings.filter((w) => /httpStatus|finalUrl/i.test(w));
  assert.equal(newWarnings.length, 0, `must NOT emit new warnings for absent httpStatus/finalUrl: ${JSON.stringify(newWarnings)}`);
});

/* ── Harvest fold — runtimeErrors onto QaCase ───────────────────────
   The harvest must fold dump.runtimeErrors onto the SAME QaCase object that today
   receives failureDom/httpStatus/finalUrl. Mirrors the finalUrl/httpStatus harvest test exactly.
 */

test("harvest folds dump.runtimeErrors onto the failed QaCase", async () => {
  const title = "owner registration › create owner";
  const file = "owners.spec.ts";
  const hash = createHash("sha1").update(`${file}/${title}`).digest("hex").slice(0, 12);

  const deps: E2eExecuteDeps = {
    runSuite: async (args) => {
      if (args.failureCaptureDir) {
        writeFileSync(
          join(args.failureCaptureDir, `desktop__${hash}__0.json`),
          JSON.stringify({
            project: "desktop",
            file,
            title,
            retry: 0,
            yaml: "- button \"Submit\"",
            runtimeErrors: [{ type: "pageerror", text: "TypeError: Cannot read properties of undefined" }],
          }),
        );
      }
      return {
        report: {
          suites: [{
            title: "owners.spec.ts",
            specs: [{
              title: "owner registration › create owner",
              ok: false,
              tests: [{ results: [{ status: "failed", error: { message: "timeout" } }] }],
            }],
          }],
        },
        logs: "failed",
        ran: true,
      };
    },
  };
  const run = await runE2E("/e2e", { baseUrl: "https://dev", namespace: "desktop" }, deps);
  const failed = run.cases.find((c) => c.status === "fail");
  assert.ok(failed, "the failing case must be present");
  assert.deepEqual(
    (failed as QaCase).runtimeErrors,
    [{ type: "pageerror", text: "TypeError: Cannot read properties of undefined" }],
    "harvest must fold dump.runtimeErrors onto the QaCase",
  );
});

test("harvest leaves runtimeErrors absent when dump has none (best-effort, no new warning)", async () => {
  const title = "form › submit";
  const file = "form.spec.ts";
  const hash = createHash("sha1").update(`${file}/${title}`).digest("hex").slice(0, 12);

  const deps: E2eExecuteDeps = {
    runSuite: async (args) => {
      if (args.failureCaptureDir) {
        writeFileSync(
          join(args.failureCaptureDir, `desktop__${hash}__0.json`),
          JSON.stringify({ project: "desktop", file, title, retry: 0, yaml: "- button \"Submit\"" }),
        );
      }
      return {
        report: {
          suites: [{ title: "form.spec.ts", specs: [{ title: "form › submit", ok: false, tests: [{ results: [{ status: "failed", error: { message: "timeout" } }] }] }] }],
        },
        logs: "failed",
        ran: true,
      };
    },
  };
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); realWarn(...a); };
  let run;
  try { run = await runE2E("/e2e", { baseUrl: "https://dev", namespace: "desktop" }, deps); }
  finally { console.warn = realWarn; }

  const failed = run.cases.find((c) => c.status === "fail");
  assert.ok(failed);
  assert.equal((failed as QaCase).runtimeErrors, undefined, "runtimeErrors must be absent when dump has none");
  const newWarnings = warnings.filter((w) => /runtimeErrors/i.test(w));
  assert.equal(newWarnings.length, 0, `must NOT emit new warnings for absent runtimeErrors: ${JSON.stringify(newWarnings)}`);
});

test("readFailureDumps parses runtimeErrors defensively (garbage/malformed entries dropped, never throws)", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-fail-dump-"));
  try {
    writeFileSync(
      join(dir, "desktop__abc123__0.json"),
      JSON.stringify({ project: "desktop", file: "x.spec.ts", title: "a › b", retry: 0, runtimeErrors: [{ type: "pageerror", text: "boom" }, "garbage", { type: 42, text: "no" }] }),
    );
    const dumps = readFailureDumps(dir);
    assert.equal(dumps.length, 1);
    assert.deepEqual(dumps[0]!.runtimeErrors, [{ type: "pageerror", text: "boom" }], "malformed entries in the array must be dropped, valid ones kept");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── Harvest fold — networkErrors + networkClass onto QaCase ─────────────
   The dump's networkErrors fold onto EVERY case (pass included — a pass case's dump exists only
   when the fixture wrote one), the URL is reduced to origin+pathname (a query can carry a secret),
   the count is capped, and networkClass is derived from the run's egress report, never reported
   by the browser.
 */

const netCase = { file: "owners.spec.ts", title: "owner registration › create owner" };

function scopeWithDenied(denied: string[]): RunScope {
  const report = newSandboxReport();
  report.denied = denied;
  return { runId: "test-run", workDir: tmpdir(), egress: { dev: [], install: [] }, report };
}

async function runWithNetworkDump(opts: { status: "pass" | "fail"; networkErrors?: unknown; backgroundNetwork?: unknown; denied?: string[] }): Promise<{ cases: QaCase[] }> {
  const hash = createHash("sha1").update(`${netCase.file}/${netCase.title}`).digest("hex").slice(0, 12);
  const deps: E2eExecuteDeps = {
    runSuite: async (args) => {
      if (args.failureCaptureDir) {
        writeFileSync(
          join(args.failureCaptureDir, `desktop__${hash}__0.json`),
          JSON.stringify({ project: "desktop", file: netCase.file, title: netCase.title, retry: 0, ...(opts.networkErrors !== undefined ? { networkErrors: opts.networkErrors } : {}), ...(opts.backgroundNetwork !== undefined ? { backgroundNetwork: opts.backgroundNetwork } : {}) }),
        );
      }
      return {
        report: {
          suites: [{
            title: netCase.file,
            specs: [{
              title: netCase.title,
              ok: opts.status === "pass",
              tests: [{ results: [{ status: opts.status === "pass" ? "passed" : "failed", ...(opts.status === "fail" ? { error: { message: "boom" } } : {}) }] }],
            }],
          }],
        },
        logs: opts.status,
        ran: true,
      };
    },
  };
  const run = await withExecScope(scopeWithDenied(opts.denied ?? []), () =>
    runE2E("/e2e", { baseUrl: "https://dev", namespace: "desktop" }, deps));
  return { cases: run.cases as QaCase[] };
}

test("harvest folds dump.networkErrors onto a FAILED case, strips the query string, and caps the count", async () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({
    url: i === 0 ? "https://api.example.com/orders?token=secret" : `https://api.example.com/orders/${i}`,
    status: 404,
  }));
  const { cases } = await runWithNetworkDump({ status: "fail", networkErrors: entries });
  const failed = cases.find((c) => c.status === "fail");
  assert.ok(failed, "the failed case must be present");
  const ne = failed.networkErrors;
  assert.ok(ne, "networkErrors must fold onto a failed case");
  assert.equal(ne.length, 10, "networkErrors must be capped at 10");
  assert.ok(ne.every((e) => !e.url.includes("?") && !e.url.includes("token")), "a query string (and its secret) must never appear");
  assert.equal(ne[0]!.url, "https://api.example.com/orders", "the URL is reduced to origin+pathname");
  assert.equal(failed.networkClass, "other", "no denied host / 5xx / DNS shape -> other");
});

test("a PASSING case carries neither network errors nor a network class, even when a dump lists a refused host", async () => {
  const { cases } = await runWithNetworkDump({
    status: "pass",
    networkErrors: [{ url: "https://errors.tracker.example/envelope", errorText: "net::ERR_FAILED", resourceType: "fetch" }],
    denied: ["errors.tracker.example"],
  });
  const passed = cases.find((c) => c.status === "pass");
  assert.ok(passed);
  assert.equal(passed.networkErrors, undefined);
  assert.equal(passed.networkClass, undefined);
});

test("networkClass is egress when a network-error host is in the run's denied list", async () => {
  const { cases } = await runWithNetworkDump({
    status: "fail",
    networkErrors: [{ url: "https://api.example.com/orders", status: 504 }],
    denied: ["api.example.com"],
  });
  assert.equal(cases.find((c) => c.status === "fail")?.networkClass, "egress", "a denied host classifies egress before a 5xx");
});

test("a denied third-party beacon, counted by the fixture as background, never classifies a case as egress", async () => {
  const { cases } = await runWithNetworkDump({
    status: "pass",
    backgroundNetwork: { count: 10, hosts: ["errors.tracker.example", "events.maps.example"] },
    denied: ["errors.tracker.example", "events.maps.example"],
  });
  const passed = cases.find((c) => c.status === "pass");
  assert.equal(passed?.networkClass, undefined, "no page-dependent error, no class");
  assert.equal(passed?.networkErrors, undefined);
});

test("a case whose refused request is a script the page needs is egress, with a refused beacon counted apart", async () => {
  const { cases } = await runWithNetworkDump({
    status: "fail",
    networkErrors: [{ url: "https://cdn.other.example/app.js", errorText: "net::ERR_FAILED", resourceType: "script" }],
    backgroundNetwork: { count: 2, hosts: ["errors.tracker.example"] },
    denied: ["errors.tracker.example", "cdn.other.example"],
  });
  assert.equal(cases.find((c) => c.status === "fail")?.networkClass, "egress");
});

test("a case whose only refused host is a background beacon is not egress", async () => {
  const { cases } = await runWithNetworkDump({
    status: "fail",
    networkErrors: [],
    backgroundNetwork: { count: 3, hosts: ["errors.tracker.example"] },
    denied: ["errors.tracker.example"],
  });
  assert.notEqual(cases.find((c) => c.status === "fail")?.networkClass, "egress");
});

test("the dump reader keeps a bounded background failure count and ignores a malformed one", () => {
  const dir = mkdtempSync(join(tmpdir(), "bg-dump-"));
  try {
    const write = (name: string, backgroundNetwork: unknown): void => writeFileSync(join(dir, `desktop__${name}__0.json`), JSON.stringify({ project: "desktop", title: name, retry: 0, backgroundNetwork }));
    write("ok", { count: 7, hosts: ["a.example", "b.example", "c.example", "d.example", "e.example", "f.example", 3, ""] });
    write("negative", { count: -1, hosts: ["a.example"] });
    write("zero", { count: 0, hosts: [] });
    write("text", "many");
    const byTitle = new Map(readFailureDumps(dir).map((d) => [d.title, d.backgroundNetwork]));
    assert.deepEqual(byTitle.get("ok"), { count: 7, hosts: ["a.example", "b.example", "c.example", "d.example", "e.example"] });
    for (const title of ["negative", "zero", "text"]) assert.equal(byTitle.get(title), undefined, title);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("networkClass is backend for a 504 with no denied host", async () => {
  const { cases } = await runWithNetworkDump({
    status: "fail",
    networkErrors: [{ url: "https://api.example.com/orders", status: 504 }],
  });
  assert.equal(cases.find((c) => c.status === "fail")?.networkClass, "backend");
});

test("networkClass is dns for net::ERR_NAME_NOT_RESOLVED", async () => {
  const { cases } = await runWithNetworkDump({
    status: "fail",
    networkErrors: [{ url: "https://api.example.com/orders", errorText: "net::ERR_NAME_NOT_RESOLVED" }],
  });
  assert.equal(cases.find((c) => c.status === "fail")?.networkClass, "dns");
});

/* ── authDir is REQUIRED in the execute/cleanup deps builders — no silent fallback to `dir` ──
   Both createDefaultE2eCleanupDeps and createDefaultE2eExecuteDeps used to accept an OPTIONAL
   authDir and fall back to `dir` (the watched-repo mirror, agent-visible) when omitted — the same
   vulnerability dom-snapshot.ts's createCaptureDomDeps no longer has. authDir is now required: a
   real TypeScript caller that forgets it gets a compile error, and — mirroring the same fail-closed
   guard idiom used in createCaptureDomDeps/PublicationPortAdapter — a caller that bypasses the type system still gets
   an immediate, loud throw instead of a silent fallback to `dir`.
 */

test("createDefaultE2eCleanupDeps requires an execution launcher — omitting it throws immediately (fail-closed, no silent run of agent code as the orchestrator)", () => {
  assert.throws(
    () =>
      // @ts-expect-error the launcher is required; omitting it must be a compile error for a real (TypeScript) caller too.
      createDefaultE2eCleanupDeps(),
    /execution launcher/i,
    "createDefaultE2eCleanupDeps must throw naming the missing launcher",
  );
});

test("createDefaultE2eExecuteDeps requires an execution launcher — omitting it throws immediately (fail-closed, no silent run of agent code as the orchestrator)", () => {
  assert.throws(
    () =>
      // @ts-expect-error the launcher is required; omitting it must be a compile error for a real (TypeScript) caller too.
      createDefaultE2eExecuteDeps(),
    /execution launcher/i,
    "createDefaultE2eExecuteDeps must throw naming the missing launcher",
  );
});

/* The real runners spawn `npx playwright ...`. A stand-in `npx` first on PATH plays Playwright, so the process boundary
   (pipes, exit, kill) is real while no browser is needed. */
async function withStandInPlaywright<T>(script: string, body: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "stand-in-npx-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(root, "playwright.cjs"), script);
  writeFileSync(join(bin, "npx"), `#!/bin/sh\nexec "${process.execPath}" "${join(root, "playwright.cjs")}" "$@"\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    return await body(root);
  } finally {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
}

test("a Playwright run that writes megabytes to stderr reports only the newest of it", { timeout: 30_000 }, async () => {
  const script = "const l = 'browser log line that repeats\\n'.repeat(1000); let n = 0; (function go() { if (n++ < 300) return process.stderr.write(l, go); process.stderr.write('THE-END\\n'); })();";
  await withStandInPlaywright(script, async (root) => {
    const deps = createDefaultE2eExecuteDeps(new ProcessKillAdapter(), 20_000, sharedTestExec());
    const out = await deps.runSuite({ dir: root, baseUrl: "http://localhost", namespace: "ns" });
    assert.match(out.logs, /THE-END/, "the newest stderr is kept");
    assert.ok(out.logs.length < E2E_STDERR_KEEP_CHARS + 500, `the kept stderr stays bounded (was ${out.logs.length} chars)`);
  });
});

test("a stream event line longer than any real event is skipped and the events around it still arrive", { timeout: 30_000 }, async () => {
  const script = [
    "const w = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "w({ e: 'begin', total: 2 });",
    `process.stdout.write(JSON.stringify({ e: 'testend', title: 'x'.repeat(${MAX_STREAM_EVENT_LINE_CHARS} * 3), status: 'passed' }) + '\\n');`,
    "w({ e: 'testend', title: 'after the long line', status: 'passed', d: 5 });",
  ].join("");
  await withStandInPlaywright(script, async (root) => {
    const events: StreamEvent[] = [];
    const deps = createDefaultE2eExecuteDeps(new ProcessKillAdapter(), 20_000, sharedTestExec());
    await deps.runSuite({ dir: root, baseUrl: "http://localhost", namespace: "ns", onEvent: (ev) => events.push(ev) });
    assert.deepEqual(events.map((e) => e.phase), ["begin", "testend"]);
    const last = events[1];
    assert.ok(last?.phase === "testend" && last.title === "after the long line", "the event after the overlong line is read normally");
  });
});

test("orphan-data cleanup whose child writes more than a pipe buffer finishes instead of blocking until the timeout", { timeout: 30_000 }, async () => {
  const script = "process.stdout.write('cleanup output\\n'.repeat(30000)); process.stderr.write('cleanup noise\\n'.repeat(30000));";
  await withStandInPlaywright(script, async (root) => {
    const warned = mock.method(console, "warn", () => {});
    try {
      const deps = createDefaultE2eCleanupDeps(new ProcessKillAdapter(), sharedTestExec());
      await deps.runCleanup({ dir: root, baseUrl: "http://localhost", namespace: "ns", timeoutMs: 4_000 });
      assert.equal(warned.mock.calls.some((c) => /timed out/.test(String(c.arguments[0]))), false, "the cleanup ended on its own, not by the timeout kill");
    } finally {
      warned.mock.restore();
    }
  });
});

test("runE2E hands the runner the cleanup-pass flag only when the caller asked for one", async () => {
  const seen: Array<boolean | undefined> = [];
  const deps: E2eExecuteDeps = {
    runSuite: async (args) => { seen.push(args.cleanupPass); return { report: { stats: { expected: 1, unexpected: 0 } }, logs: "ok", ran: true }; },
  };

  await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot", cleanupPass: true }, deps);
  await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot" }, deps);

  assert.deepEqual(seen, [true, undefined]);
});

/* What the child is given: asked of a stand-in that writes down its environment and arguments. */
async function seenByChild(run: (deps: ReturnType<typeof createDefaultE2eExecuteDeps>, root: string) => Promise<void>): Promise<{ env: Record<string, string>; argv: string[] }> {
  const script = "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'seen.json'), JSON.stringify({ env: process.env, argv: process.argv.slice(2) }));";
  let seen: { env: Record<string, string>; argv: string[] } | undefined;
  const saved: Record<string, string | undefined> = { DEV_TEST_PASS: process.env.DEV_TEST_PASS, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.DEV_TEST_PASS = "orchestrator-account-pass";
  process.env.GITHUB_TOKEN = "ghp_orchestrator";
  try {
    await withStandInPlaywright(script, async (root) => {
      await run(createDefaultE2eExecuteDeps(new ProcessKillAdapter(), 20_000, sharedTestExec()), root);
      seen = JSON.parse(readFileSync(join(root, "seen.json"), "utf8"));
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  return seen!;
}

test("runE2E hands the app's geolocation to the runner", async () => {
  const geolocation = { latitude: 40.4818, longitude: -3.3643 };
  let seen: { latitude: number; longitude: number } | undefined;
  const deps: E2eExecuteDeps = {
    geolocation,
    runSuite: async (args) => {
      seen = args.geolocation;
      return { report: { stats: { expected: 1 } }, logs: "ok", ran: true };
    },
  };
  await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns" }, deps);
  assert.deepEqual(seen, geolocation);
});

test("a Playwright suite child receives the app's geolocation", async () => {
  const geolocation = { latitude: 40.4818, longitude: -3.3643 };
  const { env } = await seenByChild((deps, root) =>
    deps.runSuite({ dir: root, baseUrl: "https://dev.example", namespace: "ns-1", geolocation }).then(() => undefined),
  );
  assert.equal(env.PW_GEO_LAT, "40.4818");
  assert.equal(env.PW_GEO_LNG, "-3.3643");
});

test("a Playwright suite child gets neither the test account nor an orchestrator secret, and the run's data prefix", async () => {
  const { env } = await seenByChild((deps, root) => deps.runSuite({ dir: root, baseUrl: "https://dev.example", namespace: "ns-1" }).then(() => undefined));
  assert.equal(env.DEV_TEST_PASS, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.PW_NAMESPACE, "ns-1");
  assert.equal(env.PW_BASE_URL, "https://dev.example");
});

test("a Playwright suite child with failure capture is not handed an origin allowlist: the resource type decides what the page depends on", async () => {
  const made = testExecSandbox({ egressOrigins: { dev: ["https://dev.example"], install: ["https://registry.npmjs.org"] } });
  try {
    const { env } = await withExecScope(made.scope, () =>
      seenByChild((deps, root) => deps.runSuite({ dir: root, baseUrl: "https://dev.example", namespace: "ns-1", failureCaptureDir: join(made.scope.workDir, "failures-y") }).then(() => undefined)));
    assert.equal(env.PW_APP_ORIGINS, undefined);
  } finally {
    made.dispose();
  }
});

test("a Playwright suite child writes its output, report and failure dumps outside the mirror it runs in", async () => {
  const { env, argv } = await seenByChild((deps, root) => deps.runSuite({ dir: root, baseUrl: "https://dev.example", namespace: "ns-1", failureCaptureDir: join(sharedTestExec().workDir(), "failures-x") }).then(() => undefined));
  const workDir = sharedTestExec().workDir();
  const output = argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length);
  assert.ok(output !== undefined && output.startsWith(workDir), `playwright output goes to ${output}, expected below ${workDir}`);
  assert.ok(env.PLAYWRIGHT_JSON_OUTPUT_NAME?.startsWith(workDir), "the JSON report goes to the work dir");
  assert.ok(env.QA_FAILURE_CAPTURE_DIR?.startsWith(workDir), "the failure dumps go to the work dir");
});

test("playwrightArgs: a single-attempt run, a title filter and the test list are all options", () => {
  const args = playwrightArgs("reporter.cjs", undefined, "/work/scripts/x-spec-list.txt", "/work/results", { retries: 0, grep: "adds \\(one\\) item" });
  assert.deepEqual(args, ["playwright", "test", "--reporter=reporter.cjs,json", "--output=/work/results", "--retries=0", "--grep=adds \\(one\\) item", "--test-list=/work/scripts/x-spec-list.txt"]);
});

test("playwrightArgs: retries must be a small non-negative integer and the grep a bounded string", () => {
  for (const retries of [-1, 1.5, Number.NaN, 11]) {
    assert.throws(() => playwrightArgs("r.cjs", undefined, undefined, undefined, { retries }), /invalid retries/);
  }
  assert.throws(() => playwrightArgs("r.cjs", undefined, undefined, undefined, { grep: "x".repeat(201) }), /invalid grep/);
  assert.throws(() => playwrightArgs("r.cjs", undefined, undefined, undefined, { grep: "" }), /invalid grep/);
  assert.deepEqual(playwrightArgs("r.cjs", undefined, undefined, undefined, {}), playwrightArgs("r.cjs"));
});

test("runE2E hands the retries and the grep to the runner", async () => {
  let seen: { retries?: number; grep?: string } = {};
  const deps: E2eExecuteDeps = {
    runSuite: async (args) => {
      seen = { retries: args.retries, grep: args.grep };
      return { report: { stats: { expected: 1 } }, logs: "ok", ran: true };
    },
  };
  await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns", retries: 0, grep: "loads" }, deps);
  assert.deepEqual(seen, { retries: 0, grep: "loads" });
});

function withLedgerDir(files: Record<string, string>): { deps: (report?: unknown) => E2eExecuteDeps; root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "qa-ledger-"));
  const dumps = join(root, "dumps");
  mkdirSync(dumps);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dumps, name), text);
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    deps: (report: unknown = { stats: { expected: 1 } }) => ({
      allocateFailureDir: () => ({ dir: dumps, root, dispose: () => {} }),
      runSuite: async () => ({ report, logs: "ok", ran: true }),
    }),
  };
}

test("runE2E reports the writes to DEV the fixtures counted, summed over the tests that ran", async () => {
  const ledger = withLedgerDir({ "ledger-0-1.json": '{"writes":2}', "ledger-1-1.json": '{"writes":3}', "unrelated.json": '{"writes":100}' });
  try {
    const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns", countWrites: true }, ledger.deps());
    assert.equal(run.devWrites, 5);
  } finally {
    ledger.cleanup();
  }
});

/* A run that was stopped (timed out, cancelled, crashed): the stream reporter told which tests began, and each of them left a ledger from its start. */
const FINISHED_LEDGER = (writes: number) => JSON.stringify({ v: 2, writes, pending: 0, done: true });
const UNFINISHED_LEDGER = (writes: number, pending: number) => JSON.stringify({ v: 2, writes, pending, done: false });

function stoppedRun(ledger: { deps: (report?: unknown) => E2eExecuteDeps }, begun: number, logs = "playwright runner timed out after 10ms — killed"): E2eExecuteDeps {
  const deps = ledger.deps();
  deps.runSuite = async (args) => {
    for (let i = 0; i < begun; i++) args.onEvent?.({ phase: "testbegin", title: `test ${i}` });
    return { report: {}, logs, ran: false };
  };
  return deps;
}

async function countOf(deps: E2eExecuteDeps): Promise<{ devWrites?: number; unfinishedTests?: number; verdict: string }> {
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns", countWrites: true }, deps);
  return { verdict: run.verdict, devWrites: run.devWrites, unfinishedTests: run.unfinishedTests };
}

test("runE2E counts a run that was stopped by its ledgers: a finished test's writes, and an unfinished test's writes plus the requests still out", async () => {
  const ledger = withLedgerDir({ "ledger-p1-w0-1.json": FINISHED_LEDGER(2), "ledger-p1-w0-2.json": UNFINISHED_LEDGER(1, 1) });
  try {
    const run = await countOf(stoppedRun(ledger, 2));
    assert.equal(run.verdict, "infra-error");
    assert.equal(run.devWrites, 4);
    assert.equal(run.unfinishedTests, 1, "the result says one test did not finish");
  } finally {
    ledger.cleanup();
  }
});

test("runE2E gives no count for a stopped run in which a test that began left no ledger", async () => {
  const ledger = withLedgerDir({ "ledger-p1-w0-1.json": FINISHED_LEDGER(2) });
  try {
    const run = await countOf(stoppedRun(ledger, 2));
    assert.equal(run.devWrites, undefined);
    assert.equal(run.unfinishedTests, undefined);
  } finally {
    ledger.cleanup();
  }
});

test("runE2E counts a stopped run in which no test began and no ledger was left as no writes, and one that executed zero tests too", async () => {
  const none = withLedgerDir({});
  const zero = withLedgerDir({});
  try {
    assert.equal((await countOf(stoppedRun(none, 0))).devWrites, 0);
    const deps = zero.deps({ suites: [], stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 } });
    assert.equal((await countOf(deps)).devWrites, 0, "a report that says no test ran, with nothing begun and nothing left");
  } finally {
    none.cleanup();
    zero.cleanup();
  }
});

test("runE2E gives no count when a ledger of a stopped run cannot be trusted: forged, oversized or unreadable", async () => {
  const forged = [
    UNFINISHED_LEDGER(1, -1),
    JSON.stringify({ v: 2, writes: 1, pending: "1", done: false }),
    JSON.stringify({ v: 2, writes: 1, pending: 0 }),
    JSON.stringify({ v: 3, writes: 1, pending: 0, done: false }),
    "x".repeat(100_000),
    "not json",
  ].map((text) => withLedgerDir({ "ledger-p1-w0-1.json": FINISHED_LEDGER(2), "ledger-p1-w0-2.json": text }));
  try {
    for (const ledger of forged) assert.equal((await countOf(stoppedRun(ledger, 2))).devWrites, undefined);
  } finally {
    for (const ledger of forged) ledger.cleanup();
  }
});

test("runE2E reads a ledger without a version as the finished test it was", async () => {
  const ledger = withLedgerDir({ "ledger-0-1.json": '{"writes":2}' });
  try {
    const run = await countOf(stoppedRun(ledger, 1));
    assert.equal(run.devWrites, 2);
    assert.equal(run.unfinishedTests, undefined);
  } finally {
    ledger.cleanup();
  }
});

test("runE2E counts the unfinished test of a run that did report, when the child ended before the test did", async () => {
  const ledger = withLedgerDir({ "ledger-p1-w0-1.json": UNFINISHED_LEDGER(3, 2) });
  try {
    const run = await countOf(ledger.deps({ stats: { expected: 1 }, suites: [] }));
    assert.equal(run.devWrites, 5);
    assert.equal(run.unfinishedTests, 1);
  } finally {
    ledger.cleanup();
  }
});

/* A stand-in launcher whose child does not die when it is killed: it exits when the test lets it, so the test can place a ledger between the kill and the exit. */
function killableLauncher(): { exec: never; workRoot: string; failures(): string; spawned: Promise<void>; child: EventEmitter & { stdout: PassThrough; stderr: PassThrough } } {
  const workRoot = mkdtempSync(join(tmpdir(), "qa-kill-exec-"));
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let failureDir = "";
  let started!: () => void;
  const spawned = new Promise<void>((resolve) => { started = resolve; });
  const exec = {
    isolated: false,
    workDir: () => workRoot,
    allocDir: (prefix: string, subdirs: readonly string[] = []) => {
      const dir = mkdtempSync(join(workRoot, `${prefix}-`));
      for (const sub of subdirs) mkdirSync(join(dir, sub), { recursive: true });
      return dir;
    },
    writeScript: (name: string, content: string) => { const path = join(workRoot, name); writeFileSync(path, content); return path; },
    spawn: (_cmd: string, _args: readonly string[], options: { extraEnv?: Record<string, string> }) => {
      failureDir = options.extraEnv?.QA_FAILURE_CAPTURE_DIR ?? "";
      child.stdout.write(`${JSON.stringify({ e: "testbegin", title: "orders › lists" })}\n`);
      started();
      return child;
    },
  };
  return { exec: exec as never, workRoot, failures: () => failureDir, spawned, child };
}

test("a ledger renamed into place after the kill and before the child exits is counted: the runner waits for the exit before it reads", async () => {
  const launcher = killableLauncher();
  try {
    const kill = {
      killTree: () => {
        setImmediate(() => {
          writeFileSync(join(launcher.failures(), ".ledger-p1-w0-1.tmp"), UNFINISHED_LEDGER(3, 1));
          renameSync(join(launcher.failures(), ".ledger-p1-w0-1.tmp"), join(launcher.failures(), "ledger-p1-w0-1.json"));
          launcher.child.emit("close", null, "SIGKILL");
        });
      },
    };
    const deps = createDefaultE2eExecuteDeps(kill as never, 60_000, launcher.exec);
    const controller = new AbortController();
    const running = runE2E(launcher.workRoot, { baseUrl: "https://dev", namespace: "ns", countWrites: true, specFiles: ["orders.spec.ts"], signal: controller.signal }, deps);
    await launcher.spawned;
    controller.abort();
    const run = await running;
    assert.equal(run.verdict, "infra-error");
    assert.equal(run.devWrites, 4, "the three answered writes and the one still out");
    assert.equal(run.unfinishedTests, 1);
  } finally {
    rmSync(launcher.workRoot, { recursive: true, force: true });
  }
});

test("a child that never exits after the kill does not hold the run: its ledgers are read once the wait for it is over", async () => {
  const launcher = killableLauncher();
  try {
    const kill = { killTree: () => { writeFileSync(join(launcher.failures(), "ledger-p1-w0-1.json"), UNFINISHED_LEDGER(1, 0)); } };
    const deps = createDefaultE2eExecuteDeps(kill as never, 60_000, launcher.exec, undefined, undefined, 25);
    const controller = new AbortController();
    const running = runE2E(launcher.workRoot, { baseUrl: "https://dev", namespace: "ns", countWrites: true, specFiles: ["orders.spec.ts"], signal: controller.signal }, deps);
    await launcher.spawned;
    controller.abort();
    const run = await running;
    assert.equal(run.devWrites, 1);
  } finally {
    rmSync(launcher.workRoot, { recursive: true, force: true });
  }
});

test("runE2E gives no count when fewer tests left a ledger than the report says ran", async () => {
  const ledger = withLedgerDir({ "ledger-0-1.json": '{"writes":0}' });
  try {
    const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns", countWrites: true }, ledger.deps({ stats: { expected: 3 }, suites: [] }));
    assert.equal(run.devWrites, undefined);
  } finally {
    ledger.cleanup();
  }
});

test("runE2E counts when every test that ran left a ledger", async () => {
  const ledger = withLedgerDir({ "ledger-0-1.json": '{"writes":1}', "ledger-0-2.json": '{"writes":0}', "ledger-1-3.json": '{"writes":2}' });
  try {
    const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns", countWrites: true }, ledger.deps({ stats: { expected: 3 }, suites: [] }));
    assert.equal(run.devWrites, 3);
  } finally {
    ledger.cleanup();
  }
});

test("runE2E reports the requests the fixtures counted by method and origin and pathname, merged, with no query", async () => {
  const ledger = withLedgerDir({
    "ledger-0-1.json": JSON.stringify({ writes: 2, requests: [{ method: "POST", url: "https://dev.example.com/api/orders?token=abc" }, { method: "DELETE", url: "https://dev.example.com/api/orders/1" }] }),
    "ledger-1-1.json": JSON.stringify({ writes: 1, requests: [{ method: "POST", url: "https://dev.example.com/api/orders" }] }),
  });
  try {
    const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns", countWrites: true }, ledger.deps());
    assert.equal(run.devWrites, 3);
    assert.deepEqual(run.devWriteRequests, [
      { method: "POST", url: "https://dev.example.com/api/orders", count: 2 },
      { method: "DELETE", url: "https://dev.example.com/api/orders/1", count: 1 },
    ]);
  } finally {
    ledger.cleanup();
  }
});

test("runE2E keeps at most the cap of distinct requests, and a ledger whose requests it cannot trust leaves the whole count unknown", async () => {
  const many = withLedgerDir({ "ledger-0-1.json": JSON.stringify({ writes: 30, requests: Array.from({ length: 20 }, (_, i) => ({ method: "PUT", url: `https://dev.example.com/a/${i}` })) }), "ledger-0-2.json": JSON.stringify({ writes: 5, requests: Array.from({ length: 5 }, (_, i) => ({ method: "PATCH", url: `https://dev.example.com/b/${i}` })) }) });
  const notAWrite = withLedgerDir({ "ledger-0-1.json": JSON.stringify({ writes: 1, requests: [{ method: "GET", url: "https://dev.example.com/a" }] }) });
  const notAUrl = withLedgerDir({ "ledger-0-1.json": JSON.stringify({ writes: 1, requests: [{ method: "POST", url: "not a url" }] }) });
  try {
    const kept = await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns", countWrites: true }, many.deps({ stats: { expected: 2 }, suites: [] }));
    assert.equal(kept.devWrites, 35);
    assert.equal(kept.devWriteRequests?.length, MAX_DEV_WRITE_REQUESTS);
    for (const deps of [notAWrite.deps(), notAUrl.deps()]) {
      const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns", countWrites: true }, deps);
      assert.equal(run.devWrites, undefined);
      assert.equal(run.devWriteRequests, undefined);
    }
  } finally {
    many.cleanup();
    notAWrite.cleanup();
    notAUrl.cleanup();
  }
});

test("runE2E does not look for a count nobody asked for", async () => {
  const ledger = withLedgerDir({ "ledger-0-1.json": '{"writes":2}' });
  try {
    assert.equal((await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns" }, ledger.deps())).devWrites, undefined);
  } finally {
    ledger.cleanup();
  }
});

test("runE2E reports no count when the fixtures left none or left something it cannot trust", async () => {
  const none = withLedgerDir({});
  const forged = withLedgerDir({ "ledger-0-1.json": '{"writes":-3}' });
  const huge = withLedgerDir({ "ledger-0-1.json": "x".repeat(100_000) });
  try {
    assert.equal((await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns", countWrites: true }, none.deps())).devWrites, undefined);
    assert.equal((await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns", countWrites: true }, forged.deps())).devWrites, undefined);
    assert.equal((await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns", countWrites: true }, huge.deps())).devWrites, undefined);
  } finally {
    none.cleanup();
    forged.cleanup();
    huge.cleanup();
  }
});

test("the default runner starts the child with the narrowing options and the write counter only when asked", async () => {
  const workRoot = mkdtempSync(join(tmpdir(), "qa-fake-exec-"));
  const spawned: Array<{ args: readonly string[]; extraEnv: Record<string, string> | undefined }> = [];
  const written: Array<{ name: string; content: string; path: string }> = [];
  const exec = {
    isolated: false,
    workDir: () => workRoot,
    allocDir: (prefix: string, subdirs: readonly string[] = []) => {
      const dir = mkdtempSync(join(workRoot, `${prefix}-`));
      for (const sub of subdirs) mkdirSync(join(dir, sub), { recursive: true });
      return dir;
    },
   
    writeScript: (name: string, content: string) => {
      const path = join(workRoot, `written-${written.length}-${name}`);
      writeFileSync(path, content);
      written.push({ name, content, path });
      return path;
    },
    spawn: (_cmd: string, args: readonly string[], options: { extraEnv?: Record<string, string> }) => {
      spawned.push({ args, extraEnv: options.extraEnv });
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      setImmediate(() => child.emit("close", 0, null));
      return child;
    },
  };
  try {
    const deps = createDefaultE2eExecuteDeps(new ProcessKillAdapter(), 5_000, exec as never);
    await deps.runSuite({ dir: workRoot, baseUrl: "https://dev", namespace: "ns", specFiles: ["a.spec.ts"], retries: 0, grep: "x", countWrites: true });
    await deps.runSuite({ dir: workRoot, baseUrl: "https://dev", namespace: "ns" });
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
  assert.ok(spawned[0]!.args.includes("--retries=0"));
  assert.ok(spawned[0]!.args.includes("--grep=x"));
  assert.equal(written.length, 1, "only the run that names spec files writes a list");
  assert.equal(written[0]!.content, "a.spec.ts\n");
  assert.ok(spawned[0]!.args.includes(`--test-list=${written[0]!.path}`), "the spec is selected by the exact list, not by a pattern");
  assert.equal(spawned[0]!.args.includes("a.spec.ts"), false, "no bare argument: Playwright reads it as an unanchored pattern over the whole path");
  assert.equal(spawned[1]!.args.some((a) => a.startsWith("--test-list")), false);
  assert.equal(spawned[0]!.extraEnv?.PW_COUNT_DEV_WRITES, "1");
  assert.equal(spawned[0]!.extraEnv?.PW_COVERAGE, "0", "a spec the generator is trying is not measured for change-coverage");
  assert.equal(spawned[1]!.args.some((a) => a.startsWith("--retries") || a.startsWith("--grep")), false);
  assert.equal(spawned[1]!.extraEnv?.PW_COUNT_DEV_WRITES, undefined);
  assert.equal(spawned[1]!.extraEnv?.PW_COVERAGE, undefined);
});

test("the default runner leads the dump folders to the work dir while the child runs, and carries over only a valid dump once it has gone", async () => {
  const root = mkdtempSync(join(tmpdir(), "qa-dump-runner-"));
  const workRoot = join(root, "work");
  const specDir = join(root, "mirror", "e2e");
  mkdirSync(join(specDir, ".qa"), { recursive: true });
  mkdirSync(workRoot, { recursive: true });
  const seen: { coverageIsLink?: boolean } = {};
  const exec = {
    isolated: false,
    workDir: () => workRoot,
    allocDir: (prefix: string, subdirs: readonly string[] = []) => {
      const dir = mkdtempSync(join(workRoot, `${prefix}-`));
      for (const sub of subdirs) mkdirSync(join(dir, sub), { recursive: true });
      return dir;
    },
    writeScript: () => "",
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      /* What the fixtures do: write below the suite's own .qa, plus a file the fixtures never write. */
      const dumpDir = join(specDir, ".qa", "coverage", "ns-dump");
      seen.coverageIsLink = lstatSync(dumpDir).isSymbolicLink();
      writeFileSync(join(dumpDir, "w0-0.json"), JSON.stringify([{ url: "https://dev/a.js", source: "x" }]));
      writeFileSync(join(dumpDir, "planted.txt"), "cookie=1");
      setImmediate(() => child.emit("close", 0, null));
      return child;
    },
  };
  try {
    const deps = createDefaultE2eExecuteDeps(new ProcessKillAdapter(), 5_000, exec as never, undefined, () => ({ ran: true, report: { stats: { expected: 1 } } }));
    await deps.runSuite({ dir: specDir, baseUrl: "https://dev", namespace: "ns-dump" });
    assert.equal(seen.coverageIsLink, true, "while the child runs, the mirror path leads to the work dir");
    const carried = join(specDir, ".qa", "coverage", "ns-dump");
    assert.equal(lstatSync(carried).isSymbolicLink(), false);
    assert.deepEqual(readdirSync(carried), ["w0-0.json"], "the planted file did not reach the mirror");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ── Harvest fold — settle facts and data state at the failure point ─────
   The capture states whether the page had settled when the test failed (data requests still in
   flight, time since the last data response, whether the tree changed on a second read) and the
   result count the app's declared data state showed there, so a transient render is never read as
   DEV's state. Parsed defensively at the same trust boundary as the other dump fields.
 */

test("readFailureDumps parses the settle facts and the result count, and drops what is malformed", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-fail-dump-"));
  try {
    writeFileSync(
      join(dir, "desktop__aaa111__0.json"),
      JSON.stringify({ project: "desktop", file: "a.spec.ts", title: "a › b", retry: 0, settle: { inFlight: 2, quietMs: 150, treeStable: false }, resultCount: 0 }),
    );
    writeFileSync(
      join(dir, "desktop__bbb222__0.json"),
      JSON.stringify({ project: "desktop", file: "c.spec.ts", title: "c › d", retry: 0, settle: { inFlight: -1, quietMs: "soon", treeStable: "yes" }, resultCount: 1.5 }),
    );
    writeFileSync(
      join(dir, "desktop__ccc333__0.json"),
      JSON.stringify({ project: "desktop", file: "e.spec.ts", title: "e › f", retry: 0, settle: { inFlight: 0, quietMs: null, treeStable: true } }),
    );
    const byTitle = new Map(readFailureDumps(dir).map((d) => [d.title, d]));
    assert.deepEqual(byTitle.get("a › b")!.settle, { inFlight: 2, quietMs: 150, treeStable: false });
    assert.equal(byTitle.get("a › b")!.resultCount, 0);
    assert.equal(byTitle.get("c › d")!.settle, undefined, "a settle object with no usable field is dropped whole");
    assert.equal(byTitle.get("c › d")!.resultCount, undefined, "a result count that is not a non-negative integer is dropped");
    assert.deepEqual(byTitle.get("e › f")!.settle, { inFlight: 0, treeStable: true }, "no data response yet: quietMs is absent, never invented");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harvest keeps every retry's failure-point capture, in retry order, next to the latest one on the case", async () => {
  const hash = createHash("sha1").update(`${netCase.file}/${netCase.title}`).digest("hex").slice(0, 12);
  const deps: E2eExecuteDeps = {
    runSuite: async (args) => {
      if (args.failureCaptureDir) {
        writeFileSync(
          join(args.failureCaptureDir, `desktop__${hash}__1.json`),
          JSON.stringify({ project: "desktop", file: netCase.file, title: netCase.title, retry: 1, yaml: "- heading \"Owners\"\n- text: 3 results", finalUrl: "https://dev/owners?page=2", settle: { inFlight: 0, quietMs: 900, treeStable: true }, resultCount: 3 }),
        );
        writeFileSync(
          join(args.failureCaptureDir, `desktop__${hash}__0.json`),
          JSON.stringify({ project: "desktop", file: netCase.file, title: netCase.title, retry: 0, yaml: "- heading \"Owners\"", finalUrl: "https://dev/owners", httpStatus: 200, settle: { inFlight: 2, quietMs: 10, treeStable: false }, resultCount: 0, runtimeErrors: [{ type: "pageerror", text: "boom" }], networkErrors: [{ url: "https://api/x", status: 502 }], backgroundNetwork: { count: 4, hosts: ["t.example"] } }),
        );
      }
      return {
        report: { suites: [{ title: netCase.file, specs: [{ title: netCase.title, ok: false, tests: [{ results: [{ status: "failed", retry: 0, error: { message: "timeout" } }, { status: "failed", retry: 1, error: { message: "timeout" } }] }] }] }] },
        logs: "failed",
        ran: true,
      };
    },
  };
  const run = await runE2E("/e2e", { baseUrl: "https://dev", namespace: "desktop" }, deps);
  const failed = run.cases.find((c) => c.status === "fail") as QaCase | undefined;
  assert.ok(failed, "the failed case must be present");
  assert.equal(failed.failureResultCount, 3, "the case keeps the latest retry's capture");
  assert.equal(failed.finalUrl, "https://dev/owners?page=2");
  const attempts = failed.failureAttempts ?? [];
  assert.deepEqual(attempts.map((a) => a.retry), [0, 1]);
  const first = attempts[0]!;
  assert.equal(first.finalUrl, "https://dev/owners");
  assert.equal(first.httpStatus, 200);
  assert.equal(first.resultCount, 0);
  assert.deepEqual(first.settle, { inFlight: 2, quietMs: 10, treeStable: false });
  assert.equal(first.runtimeErrorCount, 1);
  assert.equal(first.runtimeError, "boom");
  assert.equal(first.networkErrorCount, 1);
  assert.equal(first.backgroundNetworkCount, 4, "the background failures of the attempt are kept apart from its network errors");
  assert.equal(attempts[1]!.backgroundNetworkCount, undefined, "an attempt whose dump carried none has none");
  assert.equal(first.domLines, 1);
  assert.match(first.domSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(attempts[1]!.domLines, 2);
  assert.notEqual(attempts[1]!.domSha256, first.domSha256);
});

test("a failed case the capturing execution left no dump for has an empty attempt list, so its missing capture is told apart", async () => {
  const deps: E2eExecuteDeps = {
    runSuite: async () => ({
      report: { suites: [{ title: netCase.file, specs: [{ title: netCase.title, ok: false, tests: [{ results: [{ status: "failed", retry: 0, error: { message: "timeout" } }] }] }] }] },
      logs: "failed",
      ran: true,
    }),
  };
  const run = await runE2E("/e2e", { baseUrl: "https://dev", namespace: "desktop" }, deps);
  const failed = run.cases.find((c) => c.status === "fail") as QaCase | undefined;
  assert.ok(failed, "the failed case must be present");
  assert.deepEqual(failed.failureAttempts, []);
});

test("harvest folds the settle facts and the result count onto the failed case", async () => {
  const hash = createHash("sha1").update(`${netCase.file}/${netCase.title}`).digest("hex").slice(0, 12);
  const deps: E2eExecuteDeps = {
    runSuite: async (args) => {
      if (args.failureCaptureDir) {
        writeFileSync(
          join(args.failureCaptureDir, `desktop__${hash}__0.json`),
          JSON.stringify({ project: "desktop", file: netCase.file, title: netCase.title, retry: 0, yaml: "- heading \"Owners\"", finalUrl: "https://dev/owners", settle: { inFlight: 1, quietMs: 40, treeStable: false }, resultCount: 0 }),
        );
      }
      return {
        report: { suites: [{ title: netCase.file, specs: [{ title: netCase.title, ok: false, tests: [{ results: [{ status: "failed", error: { message: "timeout" } }] }] }] }] },
        logs: "failed",
        ran: true,
      };
    },
  };
  const run = await runE2E("/e2e", { baseUrl: "https://dev", namespace: "desktop" }, deps);
  const failed = run.cases.find((c) => c.status === "fail") as QaCase | undefined;
  assert.ok(failed, "the failed case must be present");
  assert.deepEqual(failed.failureSettle, { inFlight: 1, quietMs: 40, treeStable: false });
  assert.equal(failed.failureResultCount, 0);
});

test("runE2E hands the app's declared data state to the suite child", async () => {
  let seen: unknown;
  const dataState = { routes: { "/owners/*": { resultTextSelector: ".count", timeoutMs: 5000 } } };
  const deps: E2eExecuteDeps = {
    dataState,
    runSuite: async (args) => {
      seen = args.dataState;
      return { report: { stats: { expected: 1 } }, logs: "ok", ran: true };
    },
  };
  await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns" }, deps);
  assert.deepEqual(seen, dataState);
});

test("runE2E reports the session requests the fixtures kept apart from the writes, merged and with no query, and trusts them like the writes", async () => {
  const token = "https://id.example.com/oauth/token";
  const ledger = withLedgerDir({
    "ledger-0-1.json": JSON.stringify({ writes: 1, requests: [{ method: "POST", url: "https://dev.example.com/api/orders" }], sessionRequests: [{ method: "POST", url: `${token}?x=1` }, { method: "POST", url: token }] }),
    "ledger-1-1.json": JSON.stringify({ writes: 0, sessionRequests: [{ method: "POST", url: token }] }),
  });
  const notAWrite = withLedgerDir({ "ledger-0-1.json": JSON.stringify({ writes: 0, sessionRequests: [{ method: "GET", url: token }] }) });
  const notAList = withLedgerDir({ "ledger-0-1.json": JSON.stringify({ writes: 0, sessionRequests: "many" }) });
  try {
    const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns", countWrites: true }, ledger.deps({ stats: { expected: 2 }, suites: [] }));
    assert.equal(run.devWrites, 1);
    assert.deepEqual(run.sessionRequests, [{ method: "POST", url: token, count: 3 }]);
    for (const deps of [notAWrite.deps(), notAList.deps()]) {
      const spoiled = await runE2E("/dir", { baseUrl: "https://dev", namespace: "ns", countWrites: true }, deps);
      assert.equal(spoiled.devWrites, undefined);
      assert.equal(spoiled.sessionRequests, undefined);
    }
  } finally {
    ledger.cleanup();
    notAWrite.cleanup();
    notAList.cleanup();
  }
});
