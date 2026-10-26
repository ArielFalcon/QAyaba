/* qa-engine/test/contexts/cross-run-learning/infrastructure/process-audit-port.adapter.test.ts
   self-sources `recent` outcomes + `rules` via factory-injected reads, runs the deterministic
   auditProcess/applyAudit domain logic, and dispatches findings to 3 injected sinks
   (recordEngineIncident/deprecateRule/invalidateContext). Every failure mode (a throwing read/sink,
   a slow read past the timeout budget) is caught inline — never re-thrown — mirroring
   ReflectorPortAdapter's own documented fault-isolation contract on the sibling port.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ProcessAuditPortAdapter, PROCESS_AUDIT_TIMEOUT_MS } from "@contexts/cross-run-learning/infrastructure/process-audit-port.adapter.ts";
import type { ProcessFinding, RuleView } from "@contexts/cross-run-learning/domain/process-audit.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { NON_LEARNING, OBSERVED_OPERATING } from "@contexts/cross-run-learning/domain/learning-gates.ts";

function outcome(over: Partial<RunOutcome> = {}): RunOutcome {
  return {
    runId: over.runId ?? "r1",
    app: "petclinic",
    sha: over.sha ?? "abc1234def",
    mode: "manual",
    target: "e2e",
    verdict: over.verdict ?? "fail",
    errorClass: over.errorClass ?? "E-EXEC-FAIL",
    gateSignals: { static: false, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0, ...over.gateSignals },
    rulesRetrieved: [],
    at: over.at ?? "2026-06-13T00:00:00Z",
  };
}

const rule = (over: Partial<RuleView>): RuleView => ({ id: "ru1", errorClass: "E-EXEC-FAIL", status: "candidate", usageCount: 0, successRate: null, ...over });

test("engine-fix finding calls recordEngineIncident, and the run verdict is unaffected (nothing thrown)", async () => {
  const current = outcome({ errorClass: "E-STATIC", verdict: "invalid" });
  const incidents: ProcessFinding[] = [];
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => [current, outcome({ errorClass: "E-STATIC", sha: "b" }), outcome({ errorClass: "E-STATIC", sha: "c" })],
    readRules: () => [],
    deprecateRule: () => { throw new Error("must not be called"); },
    recordEngineIncident: (f) => incidents.push(f),
    invalidateContext: () => { throw new Error("must not be called"); },
  });

  await assert.doesNotReject(() => adapter.audit(current));

  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]!.kind, "recurring-error-class");
});

test("runs that decided nothing, like outages and flaky runs, are left out of the streak window", async () => {
  const current = outcome({ errorClass: "E-STATIC", verdict: "invalid" });
  const incidents: ProcessFinding[] = [];
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    /* Three engine-defect runs with an undecided run, an outage and a flaky run between them: without those in the window the streak is unbroken. */
    readRecentOutcomes: () => [
      current,
      outcome({ errorClass: "E-NO-DECISION", verdict: "infra-error", sha: "n" }),
      outcome({ errorClass: "E-STATIC", verdict: "invalid", sha: "b" }),
      outcome({ errorClass: "E-INFRA", verdict: "infra-error", sha: "i" }),
      outcome({ errorClass: "E-FLAKY", verdict: "flaky", sha: "f" }),
      outcome({ errorClass: "E-STATIC", verdict: "invalid", sha: "c" }),
    ],
    readRules: () => [],
    deprecateRule: () => {},
    recordEngineIncident: (f) => incidents.push(f),
    invalidateContext: () => false,
  });
  await adapter.audit(current);
  assert.equal(incidents.length, 1, "the undecided run did not break the streak");
});

test("a step-budget run stays in the streak window, so recurring exhaustion can be seen", async () => {
  const current = outcome({ errorClass: "E-STEP-BUDGET", verdict: "infra-error" });
  const logged: string[] = [];
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => [current, outcome({ errorClass: "E-STEP-BUDGET", verdict: "infra-error", sha: "b" }), outcome({ errorClass: "E-STEP-BUDGET", verdict: "infra-error", sha: "c" })],
    readRules: () => [],
    deprecateRule: () => { throw new Error("must not be called"); },
    recordEngineIncident: () => { throw new Error("must not be called"); },
    invalidateContext: () => { throw new Error("must not be called"); },
    log: (line) => logged.push(line),
  });
  await adapter.audit(current);
  assert.ok(logged.some((line) => line.includes("observe")), logged.join("\n"));
});

test("the streak window drops exactly the classes the learning gates treat as non-learning, except the ones whose own recurrence is observed", async () => {
  const observed: string[] = [];
  for (const errorClass of [...NON_LEARNING].filter((c) => !OBSERVED_OPERATING.has(c))) {
    const current = outcome({ errorClass, verdict: "infra-error" });
    const adapter = new ProcessAuditPortAdapter({
      app: "petclinic",
      readRecentOutcomes: () => [current, outcome({ errorClass, verdict: "infra-error", sha: "b" }), outcome({ errorClass, verdict: "infra-error", sha: "c" })],
      readRules: () => [],
      deprecateRule: () => {},
      recordEngineIncident: () => {},
      invalidateContext: () => false,
      log: (line) => observed.push(`${errorClass}: ${line}`),
    });
    await adapter.audit(current);
  }
  assert.deepEqual(observed, [], "a streak made only of non-learning runs is invisible to the audit");
});

test("ledger-heal finding deprecates the rule(s), no incident/context call", async () => {
  const current = outcome({ errorClass: "E-FRAGILE-SELECTOR" });
  const deprecated: Array<{ id: string; reason: string }> = [];
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => [current, outcome({ errorClass: "E-FRAGILE-SELECTOR", sha: "b" }), outcome({ errorClass: "E-FRAGILE-SELECTOR", sha: "c" })],
    readRules: () => [rule({ id: "noise1", errorClass: "E-FRAGILE-SELECTOR", usageCount: 4, status: "candidate" })],
    deprecateRule: (id, reason) => deprecated.push({ id, reason }),
    recordEngineIncident: () => { throw new Error("must not be called"); },
    invalidateContext: () => true,
  });

  await adapter.audit(current);

  assert.equal(deprecated.length, 1);
  assert.equal(deprecated[0]!.id, "noise1");
  assert.match(deprecated[0]!.reason, /noise-rule/);
});

test("context-heal finding invalidates the architecture map, no incident/deprecate call", async () => {
  const current = outcome({ errorClass: "E-FRAGILE-SELECTOR" });
  let invalidatedReason: string | undefined;
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => [current, outcome({ errorClass: "E-FRAGILE-SELECTOR", sha: "b" }), outcome({ errorClass: "E-FRAGILE-SELECTOR", sha: "c" })],
    readRules: () => [],
    deprecateRule: () => { throw new Error("must not be called"); },
    recordEngineIncident: () => { throw new Error("must not be called"); },
    invalidateContext: (reason) => { invalidatedReason = reason; return true; },
  });

  await adapter.audit(current);

  assert.ok(invalidatedReason);
  assert.match(invalidatedReason!, /recurring-ui-mismatch/);
});

test("observe finding calls no sink at all", async () => {
  const current = outcome({ verdict: "fail", gateSignals: { static: false, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 3 } });
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => [current],
    readRules: () => [],
    deprecateRule: () => { throw new Error("must not be called"); },
    recordEngineIncident: () => { throw new Error("must not be called"); },
    invalidateContext: () => { throw new Error("must not be called"); },
  });

  await assert.doesNotReject(() => adapter.audit(current));
});

test("no findings at all → no sink call, resolves cleanly", async () => {
  const current = outcome({ verdict: "pass", errorClass: null });
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => [current],
    readRules: () => [],
    deprecateRule: () => { throw new Error("must not be called"); },
    recordEngineIncident: () => { throw new Error("must not be called"); },
    invalidateContext: () => { throw new Error("must not be called"); },
  });

  await assert.doesNotReject(() => adapter.audit(current));
});

test("two-layer gating: flaky/infra-class outcomes are excluded from the recent-outcomes streak input before reaching auditProcess", async () => {
  const current = outcome({ errorClass: "E-STATIC", verdict: "invalid" });
  const incidents: ProcessFinding[] = [];
  /* Raw feed: current + a FLAKY entry with a DIFFERENT errorClass wedged in the window + 2 more
     E-STATIC entries. Unfiltered, slice(0,3) = [E-STATIC, E-FLAKY, E-STATIC] never matches (breaks
     the streak) — the recurring-error-class finding would NOT fire. Filtered (excluding the flaky
     entry), the streak becomes 3 consecutive E-STATIC entries and the finding DOES fire — proving
     the adapter filters before calling into auditProcess, not merely inside the domain function.
   */
  const rawRecent: RunOutcome[] = [
    current,
    outcome({ verdict: "flaky", errorClass: "E-FLAKY", sha: "noise" }),
    outcome({ errorClass: "E-STATIC", sha: "b" }),
    outcome({ errorClass: "E-STATIC", sha: "c" }),
  ];
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => rawRecent,
    readRules: () => [],
    deprecateRule: () => {},
    recordEngineIncident: (f) => incidents.push(f),
    invalidateContext: () => true,
  });

  await adapter.audit(current);

  assert.equal(incidents.length, 1, "the flaky-noise entry must be excluded from the streak so the real 3-in-a-row is recognized");
  assert.equal(incidents[0]!.kind, "recurring-error-class");
});

test("two-layer gating: an E-INFRA recent entry is also excluded from the streak input", async () => {
  const current = outcome({ errorClass: "E-STATIC", verdict: "invalid" });
  const incidents: ProcessFinding[] = [];
  const rawRecent: RunOutcome[] = [
    current,
    outcome({ verdict: "infra-error", errorClass: "E-INFRA", sha: "noise" }),
    outcome({ errorClass: "E-STATIC", sha: "b" }),
    outcome({ errorClass: "E-STATIC", sha: "c" }),
  ];
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => rawRecent,
    readRules: () => [],
    deprecateRule: () => {},
    recordEngineIncident: (f) => incidents.push(f),
    invalidateContext: () => true,
  });

  await adapter.audit(current);

  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]!.kind, "recurring-error-class");
});

test("fault isolation: a throwing readRecentOutcomes is caught, never rethrown, onAuditError is called", async () => {
  let reportedError: unknown;
  const current = outcome();
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => { throw new Error("db exploded"); },
    readRules: () => [],
    deprecateRule: () => {},
    recordEngineIncident: () => {},
    invalidateContext: () => true,
    onAuditError: (e) => { reportedError = e; },
  });

  await assert.doesNotReject(() => adapter.audit(current));
  assert.ok(reportedError instanceof Error);
  assert.match((reportedError as Error).message, /db exploded/);
});

test("fault isolation: a throwing sink is caught, never rethrown", async () => {
  const current = outcome({ errorClass: "E-STATIC", verdict: "invalid" });
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => [current, outcome({ errorClass: "E-STATIC", sha: "b" }), outcome({ errorClass: "E-STATIC", sha: "c" })],
    readRules: () => [],
    deprecateRule: () => {},
    recordEngineIncident: () => { throw new Error("maintainer sink exploded"); },
    invalidateContext: () => true,
  });

  await assert.doesNotReject(() => adapter.audit(current));
});

test("timeout-capped: a hanging read never blocks audit() past the configured timeout, and is logged", async () => {
  const current = outcome();
  const lines: string[] = [];
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => new Promise<RunOutcome[]>(() => {}), /* never resolves */
    readRules: () => [],
    deprecateRule: () => {},
    recordEngineIncident: () => {},
    invalidateContext: () => true,
    timeoutMs: 20,
    log: (line) => lines.push(line),
  });

  const start = Date.now();
  await assert.doesNotReject(() => adapter.audit(current));
  assert.ok(Date.now() - start < 2_000, "audit() must resolve near the configured timeoutMs, not hang");
  assert.ok(lines.some((l) => l.includes("timed out")));
});

test("PROCESS_AUDIT_TIMEOUT_MS default is exported and positive", () => {
  assert.ok(PROCESS_AUDIT_TIMEOUT_MS > 0);
});

/* ── The operating signal: recurring time-budget ends ───────────────────────────────────────────── */

function timeBudget(sha: string): RunOutcome {
  return outcome({ errorClass: "E-TIME-BUDGET", verdict: "infra-error", sha });
}

function auditing(recent: RunOutcome[]) {
  const logs: string[] = [];
  const incidents: ProcessFinding[] = [];
  const deprecated: string[] = [];
  let invalidated = 0;
  const adapter = new ProcessAuditPortAdapter({
    app: "petclinic",
    readRecentOutcomes: () => recent,
    readRules: () => [],
    deprecateRule: (id) => { deprecated.push(id); },
    recordEngineIncident: (f) => { incidents.push(f); },
    invalidateContext: () => { invalidated++; return true; },
    log: (line) => logs.push(line),
  });
  return { adapter, logs, incidents, deprecated, invalidated: () => invalidated };
}

test("three time-budget ends in a row are made visible as an observe-only finding", async () => {
  const current = timeBudget("a");
  const { adapter, logs } = auditing([current, timeBudget("b"), timeBudget("c")]);
  await adapter.audit(current);
  assert.equal(logs.filter((l) => l.includes("[audit] observe (recurring-time-exhaustion)")).length, 1);
  assert.match(logs.join("\n"), /E-TIME-BUDGET 3 runs in a row/);
});

test("a recurring time-budget end never wakes the maintainer, deprecates a rule or rebuilds the map", async () => {
  const current = timeBudget("a");
  const { adapter, incidents, deprecated, invalidated } = auditing([current, timeBudget("b"), timeBudget("c")]);
  await adapter.audit(current);
  assert.deepEqual([incidents.length, deprecated.length, invalidated()], [0, 0, 0]);
});

test("two time-budget ends in a row are not yet a streak", async () => {
  const current = timeBudget("a");
  const { adapter, logs } = auditing([current, timeBudget("b"), outcome({ errorClass: "E-EXEC-FAIL", sha: "c" })]);
  await adapter.audit(current);
  assert.equal(logs.length, 0);
});

test("an outage or a flaky run between time-budget ends neither extends nor breaks their streak", async () => {
  const current = timeBudget("a");
  const { adapter, logs } = auditing([
    current,
    outcome({ errorClass: "E-INFRA", verdict: "infra-error", sha: "i" }),
    timeBudget("b"),
    outcome({ errorClass: "E-FLAKY", verdict: "flaky", sha: "f" }),
    timeBudget("c"),
  ]);
  await adapter.audit(current);
  assert.equal(logs.filter((l) => l.includes("recurring-time-exhaustion")).length, 1);
});

test("the time-budget ends stay out of the window of any other class's audit, as before", async () => {
  const current = outcome({ errorClass: "E-STATIC", verdict: "invalid" });
  const { adapter, incidents } = auditing([current, timeBudget("t"), outcome({ errorClass: "E-STATIC", verdict: "invalid", sha: "b" }), outcome({ errorClass: "E-STATIC", verdict: "invalid", sha: "c" })]);
  await adapter.audit(current);
  assert.equal(incidents.length, 1, "the engine-defect streak of E-STATIC is not broken by a run that decided nothing");
});

test("three unavailable-reviewer runs in a row are made visible as an observe-only finding, and never wake the maintainer", async () => {
  const unavailable = (sha: string) => outcome({ errorClass: "E-REVIEWER-UNAVAILABLE", verdict: "infra-error", sha });
  const current = unavailable("a");
  const { adapter, logs, incidents } = auditing([current, unavailable("b"), unavailable("c")]);
  await adapter.audit(current);
  assert.equal(logs.filter((l) => l.includes("[audit] observe (recurring-reviewer-unavailable)")).length, 1);
  assert.equal(incidents.length, 0);
});
