/* The execution of a suite as spans, synthesized from the Playwright JSON report, over the real telemetry adapter. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { synthesizeReportSpans } from "../../qa-engine/src/contexts/test-execution/infrastructure/report-spans";
import { ThrowingTelemetry } from "@kernel/telemetry/guarded-telemetry";
import { planReport, MAX_PLANNED_CASES } from "../../qa-engine/src/contexts/test-execution/domain/playwright-report-plan";
import { newSandboxReport, withExecScope } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-scope";
import { createRunSecretScope, withRunSecretScope } from "../../qa-engine/src/shared-infrastructure/run-secret-redaction";
import { traceHarness, T0 } from "./trace-harness";

const NOW = () => T0 + 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const ms = (t: [number, number]): number => t[0] * 1e3 + t[1] / 1e6;

const STRICT_MESSAGE = "Error: locator.click: Error: strict mode violation: getByRole('button', { name: 'Save' }) resolved to 3 elements:\n    1) <button>";

const REPORT = {
  suites: [
    {
      title: "flows/orders.spec.ts",
      file: "flows/orders.spec.ts",
      specs: [],
      suites: [
        {
          title: "orders",
          specs: [
            { title: "lists orders", tests: [{ status: "expected", results: [{ status: "passed", duration: 1500, retry: 0, startTime: iso(T0 + 1000) }] }] },
            {
              title: "saves an order",
              tests: [
                {
                  status: "flaky",
                  results: [
                    { status: "failed", duration: 2000, retry: 0, startTime: iso(T0 + 3000), error: { message: STRICT_MESSAGE } },
                    { status: "passed", duration: 1000, retry: 1, startTime: iso(T0 + 6000) },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      title: "flows/profile.spec.ts",
      file: "flows/profile.spec.ts",
      specs: [
        {
          title: "shows the name",
          tests: [{ status: "unexpected", results: [{ status: "failed", duration: 800, retry: 0, startTime: iso(T0 + 9000), error: { message: "Error: expect(locator).toBeVisible() failed\n\nLocator: getByTestId('name')\nReceived: <element(s) not found>" } }] }],
        },
      ],
    },
  ],
};

test("a spec file, each case and each attempt become spans with the report's own times", async () => {
  const h = traceHarness();
  const phase = h.telemetry.startSpan("qayaba.phase.execute");
  h.telemetry.withParent(phase, () => synthesizeReportSpans({ telemetry: h.telemetry, now: NOW }, REPORT));
  phase.end();

  const files = h.named("qayaba.spec.execute");
  assert.deepEqual(files.map((s) => s.attributes["qayaba.spec.file"]), ["flows/orders.spec.ts", "flows/profile.spec.ts"]);
  const orders = files[0]!;
  assert.equal(ms(orders.startTime), T0 + 1000);
  assert.equal(ms(orders.endTime), T0 + 7000);
  assert.equal(orders.attributes["qayaba.span.synthesized"], true);
  assert.equal(orders.attributes["qayaba.time.source"], "report");

  const tests = h.named("qayaba.test");
  assert.equal(tests.length, 3);
  const saves = tests.find((s) => s.attributes["qayaba.test.name"] === "orders › saves an order")!;
  assert.equal(saves.attributes["qayaba.test.status"], "flaky");
  assert.equal(saves.attributes["qayaba.test.retries"], 1);
  assert.equal(saves.parentSpanContext?.spanId, orders.spanContext().spanId);

  const attempts = h.named("qayaba.attempt").filter((s) => s.parentSpanContext?.spanId === saves.spanContext().spanId);
  assert.deepEqual(attempts.map((s) => s.attributes["qayaba.test.attempt"]), [0, 1]);
  assert.equal(ms(attempts[0]!.startTime), T0 + 3000);
  assert.equal(ms(attempts[0]!.endTime), T0 + 5000);
  assert.equal(attempts[0]!.attributes["qayaba.test.status"], "failed");
  assert.deepEqual(h.unended(), []);
});

test("the files hang under the phase that was open when the report was read", () => {
  const h = traceHarness();
  const phase = h.telemetry.startSpan("qayaba.phase.execute");
  h.telemetry.withParent(phase, () => synthesizeReportSpans({ telemetry: h.telemetry, now: NOW }, REPORT));
  phase.end();
  for (const file of h.named("qayaba.spec.execute")) assert.equal(file.parentSpanContext?.spanId, phase.context().spanId);
});

test("a strict mode violation is an event with the number of elements and the kind of locator", () => {
  const h = traceHarness();
  synthesizeReportSpans({ telemetry: h.telemetry, now: NOW }, REPORT);
  const failed = h.named("qayaba.attempt").find((s) => s.events.some((e) => e.name === "strict_mode_violation"))!;
  const event = failed.events.find((e) => e.name === "strict_mode_violation")!;
  assert.equal(event.attributes?.["qayaba.selector.match_count"], 3);
  assert.equal(event.attributes?.["qayaba.selector.strategy"], "role");
  assert.equal(failed.attributes["qayaba.test.failure_category"], "selector");
  const saves = h.named("qayaba.test").find((s) => s.attributes["qayaba.test.name"] === "orders › saves an order")!;
  assert.equal(saves.attributes["qayaba.selector.strategy"], "role");
});

test("a failed case carries the category of its failure and a passing one carries none", () => {
  const h = traceHarness();
  synthesizeReportSpans({ telemetry: h.telemetry, now: NOW }, REPORT);
  const byName = (name: string) => h.named("qayaba.test").find((s) => s.attributes["qayaba.test.name"] === name)!;
  assert.equal(byName("shows the name").attributes["qayaba.test.failure_category"], "selector");
  assert.equal(byName("shows the name").attributes["qayaba.test.status"], "failed");
  assert.equal(byName("shows the name").attributes["qayaba.selector.strategy"], "testid");
  assert.equal(byName("orders › lists orders").attributes["qayaba.test.failure_category"], undefined);
});

test("every case counts once in qayaba.tests by its status and failure category", () => {
  const h = traceHarness();
  synthesizeReportSpans({ telemetry: h.telemetry, now: NOW }, REPORT);
  const counted = h.measurements.filter((m) => m.name === "qayaba.tests").map((m) => m.attrs);
  assert.equal(counted.length, 3);
  assert.deepEqual(counted.find((a) => a["qayaba.test.status"] === "failed"), { "qayaba.test.status": "failed", "qayaba.test.failure_category": "selector" });
  assert.deepEqual(counted.find((a) => a["qayaba.test.status"] === "passed"), { "qayaba.test.status": "passed" });
});

test("a report that is not a report, or whose fields have the wrong types, yields no spans and no error", () => {
  const h = traceHarness();
  for (const junk of [undefined, null, 42, "x", [], { suites: "no" }, { suites: [null, 3, { specs: [{ tests: "no" }] }] }]) synthesizeReportSpans({ telemetry: h.telemetry, now: NOW }, junk);
  assert.equal(h.spans().length, 0);
});

test("a hostile report is bounded: only so many cases are planned and a duration cannot run for years", () => {
  const many = { suites: [{ title: "f.spec.ts", file: "f.spec.ts", specs: Array.from({ length: MAX_PLANNED_CASES + 5 }, (_, i) => ({ title: `t${i}`, tests: [{ status: "expected", results: [{ status: "passed", duration: 1e15, startTime: iso(T0) }] }] })) }] };
  const plan = planReport(many, { nowMs: T0 });
  assert.equal(plan.files[0]!.cases.length, MAX_PLANNED_CASES);
  assert.equal(plan.omitted, 5);
  assert.ok(plan.files[0]!.cases[0]!.endMs - plan.files[0]!.cases[0]!.startMs <= 24 * 60 * 60 * 1000);
});

test("a case with no start time in the report starts where the previous one ended", () => {
  const plan = planReport({ suites: [{ title: "f.spec.ts", specs: [{ title: "a", tests: [{ status: "expected", results: [{ status: "passed", duration: 10, startTime: iso(T0) }, { status: "passed", duration: 5 }] }] }] }] }, { nowMs: T0 + 99 });
  assert.deepEqual(plan.files[0]!.cases[0]!.attempts.map((a) => [a.startMs, a.endMs]), [[T0, T0 + 10], [T0 + 10, T0 + 15]]);
});

test("a telemetry port that throws on every call does not make the synthesis throw", () => {
  assert.doesNotThrow(() => synthesizeReportSpans({ telemetry: new ThrowingTelemetry(), now: NOW }, REPORT));
});

test("an error message is redacted by the run's own secrets before it is exported", async () => {
  const { createRunSecretScope, withRunSecretScope } = await import("../../qa-engine/src/shared-infrastructure/run-secret-redaction");
  const h = traceHarness();
  const secrets = createRunSecretScope();
  secrets.addAccountSecrets(["hunter2-secret-value"]);
  const leaky = { suites: [{ title: "f.spec.ts", specs: [{ title: "a", tests: [{ status: "unexpected", results: [{ status: "failed", duration: 5, retry: 0, startTime: iso(T0), error: { message: "expect(received).toBe(expected)\nReceived: hunter2-secret-value" } }] }] }] }] };
  withRunSecretScope(secrets, () => synthesizeReportSpans({ telemetry: h.telemetry, now: NOW }, leaky));
  const text = JSON.stringify(h.spans().map((s) => [s.name, s.attributes, s.events]));
  assert.equal(text.includes("hunter2-secret-value"), false);
  assert.equal(h.named("qayaba.attempt").length, 1);
});

test("the runner hands the report to its observer once, and the verdict is the same whether the observer traces, throws or is absent", async () => {
  const { runE2E } = await import("../../qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner");
  const passing = {
    stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    suites: [{ title: "flows/a.spec.ts", file: "flows/a.spec.ts", specs: [{ title: "a", tests: [{ status: "expected", results: [{ status: "passed", duration: 10, retry: 0, startTime: iso(T0) }] }] }] }],
  };
  const run = (onReport?: (report: unknown) => void) =>
    runE2E("/nonexistent/e2e", { baseUrl: "https://dev.example.com", namespace: "ns" }, { runSuite: async () => ({ report: passing, logs: "", ran: true, exitCode: 0 }), ...(onReport ? { onReport } : {}) });
  const h = traceHarness();
  let told = 0;
  const traced = await run((report) => {
    told += 1;
    synthesizeReportSpans({ telemetry: h.telemetry, now: NOW }, report);
  });
  const thrown = await run(() => {
    throw new Error("observer exploded");
  });
  const absent = await run();
  assert.equal(told, 1);
  assert.equal(h.named("qayaba.test").length, 1);
  assert.equal(traced.verdict, "pass");
  assert.deepEqual(thrown, absent);
  assert.deepEqual(traced, absent);
});

test("a run that produced no report is not told to the observer", async () => {
  const { runE2E } = await import("../../qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner");
  let told = 0;
  const out = await runE2E("/nonexistent/e2e", { baseUrl: "https://dev.example.com", namespace: "ns" }, { runSuite: async () => ({ report: {}, logs: "", ran: false }), onReport: () => { told += 1; } });
  assert.equal(out.verdict, "infra-error");
  assert.equal(told, 0);
});

/* ---- a report is agent-influenced: its times and its size are bounded ---- */

function reportWith(startTime: string, duration: number, extra: Record<string, unknown> = {}) {
  return { suites: [{ title: "f.spec.ts", file: "f.spec.ts", specs: [{ title: "a", tests: [{ status: "expected", results: [{ status: "passed", duration, retry: 0, startTime, ...extra }] }] }] }] };
}

test("a start time from the future is held at now, one from long before the phase at a minute before it, and an end never precedes its start", () => {
  const phaseStart = T0 + 10_000;
  const planned = (iso0: string, duration: number) =>
    planReport(reportWith(iso0, duration), { nowMs: T0 + 60_000, phaseStartMs: phaseStart }).files[0]!.cases[0]!;
  const future = planned(iso(T0 + 9_999_999_999), 5_000);
  assert.deepEqual([future.startMs, future.endMs], [T0 + 60_000, T0 + 60_000]);
  const ancient = planned(iso(T0 - 9_999_999_999), 1_000);
  assert.deepEqual([ancient.startMs, ancient.endMs], [phaseStart - 60_000, phaseStart - 59_000]);
  const negative = planned(iso(T0 + 20_000), -5_000);
  assert.deepEqual([negative.startMs, negative.endMs], [T0 + 20_000, T0 + 20_000]);
  const long = planned(iso(T0 + 20_000), 9_999_999_999);
  assert.equal(long.endMs, T0 + 60_000);
});

test("the phase's own start bounds the spans that are exported", () => {
  const h = traceHarness();
  const phase = h.telemetry.startSpan("qayaba.phase.execute");
  const scope = { runId: "r", workDir: "", egress: { dev: [], install: [] }, report: newSandboxReport(), telemetry: { parent: () => phase.context(), phaseStart: () => T0 + 10_000 } };
  withExecScope(scope, () => synthesizeReportSpans({ telemetry: h.telemetry, now: NOW }, reportWith(iso(T0 - 5_000_000), 1_000)));
  phase.end();
  assert.equal(ms(h.only("qayaba.spec.execute").startTime), T0 + 10_000 - 60_000);
});

function manyCases(n: number, retries = 0) {
  return {
    suites: [{
      title: "f.spec.ts",
      file: "f.spec.ts",
      specs: Array.from({ length: n }, (_, i) => ({ title: `t${i}`, tests: [{ status: "expected", results: Array.from({ length: retries + 1 }, (_r, r) => ({ status: "passed", duration: 1, retry: r, startTime: iso(T0 + i)})) }] })),
    }],
  };
}

test("one report makes at most 500 spans, counts what it left out on the phase, and still counts every case in the metric", () => {
  const h = traceHarness();
  const phase = h.telemetry.startSpan("qayaba.phase.execute");
  const scope = { runId: "r", workDir: "", egress: { dev: [], install: [] }, report: newSandboxReport(), telemetry: { parent: () => phase.context(), annotate: (attrs: Record<string, unknown>) => phase.setAttrs(attrs as never) } };
  withExecScope(scope, () => synthesizeReportSpans({ telemetry: h.telemetry, now: NOW }, manyCases(400, 1)));
  phase.end();
  /* 1 file span + (1 test + 2 attempts) per case: 1 + 3 * 166 = 499 spans, the 167th case does not fit. */
  assert.equal(h.spans().filter((s) => s.name !== "qayaba.phase.execute").length, 499);
  assert.equal(h.only("qayaba.phase.execute").attributes["qayaba.spans.synthesized_dropped"], 3 * (400 - 166));
  assert.equal(h.measurements.filter((m) => m.name === "qayaba.tests").length, 400);
});

function fileWith(name: string, cases: number, retries = 0) {
  return { title: name, file: name, specs: Array.from({ length: cases }, (_, i) => ({ title: `t${i}`, tests: [{ status: "expected", results: Array.from({ length: retries + 1 }, (_r, r) => ({ status: "passed", duration: 1, retry: r, startTime: iso(T0 + i) })) }] })) };
}

function phaseScope(h: ReturnType<typeof traceHarness>, name: string) {
  const phase = h.telemetry.startSpan(name);
  const scope = { runId: "r", workDir: "", egress: { dev: [], install: [] }, report: newSandboxReport(), telemetry: { parent: () => phase.context(), annotate: (attrs: Record<string, unknown>) => phase.setAttrs(attrs as never) } };
  return { phase, scope };
}

test("a spec file none of whose cases fit is not a span, and the dropped count is the phase's own", () => {
  const h = traceHarness();
  const first = phaseScope(h, "qayaba.phase.execute");
  withExecScope(first.scope, () => synthesizeReportSpans({ telemetry: h.telemetry, now: NOW }, { suites: [fileWith("a.spec.ts", 166, 1), fileWith("b.spec.ts", 3, 1)] }));
  first.phase.end();
  assert.deepEqual(h.named("qayaba.spec.execute").map((s) => s.attributes["qayaba.spec.file"]), ["a.spec.ts"]);
  assert.equal(h.only("qayaba.phase.execute").attributes["qayaba.spans.synthesized_dropped"], 9);
});

test("the dropped count belongs to the phase it was dropped in: one phase adds its reports, and another phase starts from nothing", () => {
  const h = traceHarness();
  /* One scope for the whole run, as in a real run, whose open phase changes. */
  let open = h.telemetry.startSpan("qayaba.phase.execute");
  const scope = { runId: "r", workDir: "", egress: { dev: [], install: [] }, report: newSandboxReport(), telemetry: { parent: () => open.context(), annotate: (attrs: Record<string, unknown>) => open.setAttrs(attrs as never) } };
  withExecScope(scope, () => {
    synthesizeReportSpans({ telemetry: h.telemetry, now: NOW }, manyCases(400, 1));
    synthesizeReportSpans({ telemetry: h.telemetry, now: NOW }, manyCases(400, 1));
  });
  const executeSpan = open;
  open = h.telemetry.startSpan("qayaba.phase.fix_loop");
  withExecScope(scope, () => synthesizeReportSpans({ telemetry: h.telemetry, now: NOW }, manyCases(2)));
  executeSpan.end();
  open.end();
  /* The first report drops 3 * (400 - 166) spans; the second finds the run's tally and drops more, all of it counted on the execute phase. */
  assert.ok(Number(h.only("qayaba.phase.execute").attributes["qayaba.spans.synthesized_dropped"]) > 702);
  assert.equal(h.only("qayaba.phase.fix_loop").attributes["qayaba.spans.synthesized_dropped"], undefined);
});

test("one run makes at most 2000 spans across its reports", () => {
  const h = traceHarness();
  const phase = h.telemetry.startSpan("qayaba.phase.execute");
  const scope = { runId: "r", workDir: "", egress: { dev: [], install: [] }, report: newSandboxReport(), telemetry: { parent: () => phase.context(), annotate: (attrs: Record<string, unknown>) => phase.setAttrs(attrs as never) } };
  withExecScope(scope, () => {
    for (let i = 0; i < 8; i += 1) synthesizeReportSpans({ telemetry: h.telemetry, now: NOW }, manyCases(150));
  });
  phase.end();
  const made = h.spans().filter((s) => s.name !== "qayaba.phase.execute").length;
  assert.ok(made <= 2000 && made > 1900, `made ${made}`);
  assert.ok(Number(h.only("qayaba.phase.execute").attributes["qayaba.spans.synthesized_dropped"]) > 0);
});

test("a spec file name that carries a secret of the run, or a pattern the sanitizer knows, is cleaned before export", () => {
  const h = traceHarness();
  const secrets = createRunSecretScope();
  secrets.addAccountSecrets(["hunter2-secret-value"]);
  const report = { suites: [{ title: "x", file: "flows/hunter2-secret-value/ghp_0123456789abcdefghijklmnopqrstuvwxyz01.spec.ts", specs: [{ title: "a", tests: [{ status: "expected", results: [{ status: "passed", duration: 1, retry: 0, startTime: iso(T0) }] }] }] }] };
  withRunSecretScope(secrets, () => synthesizeReportSpans({ telemetry: h.telemetry, now: NOW }, report));
  const file = String(h.only("qayaba.spec.execute").attributes["qayaba.spec.file"]);
  assert.equal(file.includes("hunter2-secret-value"), false);
  assert.equal(file.includes("ghp_0123456789"), false);
});
