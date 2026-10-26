/*
 * How a run ends, through `finalizeRun` alone: each end becomes a result and does to the working copy, the run history, publication
 * and learning exactly what its reason calls for. The run-end table drives whole runs; this drives each end without one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { ERROR_CLASS } from "@kernel/error-class.ts";
import { CycleBudget } from "@kernel/cycle-budget.ts";
import { WallClockBudget } from "@kernel/wall-clock-budget.ts";
import { RunPhaseCursor } from "@contexts/run-orchestration/domain/run-phase-cursor.ts";
import { PhaseSpans } from "@contexts/run-orchestration/application/run-phase-spans.ts";
import { finalizeRun, recordCrashEvidence } from "@contexts/run-orchestration/application/run-flow/finalize-run.ts";
import { END_EFFECTS, END_REASONS, runEnd, type EndReason, type RunEnd } from "@contexts/run-orchestration/application/run-flow/run-end.ts";
import type { RunContext, WorkspaceRunContext } from "@contexts/run-orchestration/application/run-flow/run-context.ts";
import { recordRunFact } from "@contexts/run-orchestration/application/run-flow/reducers.ts";
import { initialRunState, type RunState } from "@contexts/run-orchestration/application/run-flow/run-state.ts";
import { decide, type RunEvidence } from "@contexts/run-orchestration/domain/run-decision.service.ts";
import type { RunQaConfig, RunQaInput, RunQaResult, RunQaUseCaseDeps } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import { RUN_END_ROWS } from "./run-end-rows.ts";
import { dispose, newRig } from "./run-end-rig.ts";
import type { WorkspaceHandle } from "@contexts/workspace-and-publication/application/index.ts";
import { fakeHandle, rootsOf } from "./fake-workspace.ts";
import { primaryChangeSet } from "../../../../support/change-set.ts";

const MIRROR = "/mirrors/org__app";

/* What the end did to the outside, in the order it did it. */
interface Calls {
  order: string[];
  saved: RunOutcome[];
  folded: RunOutcome[];
  published: unknown[];
  reflected: number;
  audited: number;
  pruned: string[];
  done: number;
}

function context(opts: { mode?: RunQaInput["mode"]; mirrorDir?: string | undefined; config?: Partial<RunQaConfig> } = {}): { ctx: RunContext; calls: Calls; state: RunState } {
  const calls: Calls = { order: [], saved: [], folded: [], published: [], reflected: 0, audited: 0, pruned: [], done: 0 };
  const cfg: RunQaConfig = { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: false, reviewLoopIntegrity: false, coveragePolicyMode: "signal", ...opts.config };
  const deps = {
    publication: { publish: async (input: unknown) => { calls.order.push("publish"); calls.published.push(input); return { outcome: "issue #7 opened" }; } },
    runHistory: { save: async (outcome: RunOutcome) => { calls.order.push("save"); calls.saved.push(outcome); } },
    learning: { fold: async (outcome: RunOutcome) => { calls.order.push("fold"); calls.folded.push(outcome); } },
    reflector: { reflect: async () => { calls.order.push("reflect"); calls.reflected += 1; } },
    processAudit: { audit: async () => { calls.order.push("audit"); calls.audited += 1; } },
    observer: { onStep: (step: string) => { if (step === "done") calls.done += 1; }, onEvent: () => {} },
  } as unknown as RunQaUseCaseDeps;
  const clock = { now: () => 0 };
  const spans = new PhaseSpans({ telemetry: new NoopTelemetry(), secrets: { redact: (text: string) => text } as never, app: "demo", mode: opts.mode ?? "diff" });
  const trail = { phases: new RunPhaseCursor(clock, spans), spans };
  const state = initialRunState();
  const mirrorDir = "mirrorDir" in opts ? opts.mirrorDir : MIRROR;
  const cycleBudget = CycleBudget.derive({ maxRetries: cfg.maxRetries });
  const ctx: RunContext & { workspace?: WorkspaceHandle } = {
    input: { app: "demo", changeSet: primaryChangeSet("demo", Sha.of("abc1234")), sha: Sha.of("abc1234"), source: "manual", mode: opts.mode ?? "diff", target: "e2e", runId: "finalize-run" },
    signal: undefined,
    trail,
    deps,
    telemetry: new NoopTelemetry(),
    cfg,
    startedAt: 0,
    cycleBudget,
    wallClockBudget: WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 0 }),
    ...(mirrorDir ? { workspace: fakeHandle({ mirrorDir, specDir: `${mirrorDir}/e2e` }) } : {}),
    host: {
      pruneMirror: async (workspace: WorkspaceHandle) => { calls.order.push("prune"); calls.pruned.push(rootsOf(workspace).mirrorDir); },
      coordination: () => undefined,
      sandboxRefused: () => false,
      sandboxSignal: () => undefined,
    } as unknown as RunContext["host"],
  };
  return { ctx, calls, state };
}

async function end(reason: RunEnd, ctxOpts?: Parameters<typeof context>[0]): Promise<{ result: RunQaResult; calls: Calls }> {
  const { ctx, calls, state } = context(ctxOpts);
  return { result: await finalizeRun(reason, ctx, state), calls };
}

const EVIDENCE = { rulesRetrieved: ["rule-1"], diffArchetypes: ["form-change"], archetype: "form-change", retries: 1 };

test("an aborted run is an infra-error with no note, nothing recorded or published, and its working copy pruned", async () => {
  const { result, calls } = await end(runEnd("aborted"));
  assert.equal(result.decision.verdict, "infra-error");
  assert.equal(result.decision.sideEffect, "none");
  assert.equal(result.errorClass, ERROR_CLASS.INFRA);
  assert.equal(result.note, undefined);
  assert.deepEqual(calls.order, ["prune"]);
  assert.deepEqual(calls.pruned, [MIRROR]);
  assert.equal(calls.done, 1);
});

test("an end before the working copy exists prunes nothing", async () => {
  const { calls } = await end(runEnd("aborted"), { mirrorDir: undefined });
  assert.deepEqual(calls.order, []);
});

for (const reason of ["deploy-gate-failed", "setup-failed", "auth-failed", "generation-empty-output", "final-proof-guard"] as const) {
  test(`${reason} is an unrecorded infra-error carrying its note`, async () => {
    const { result, calls } = await end(runEnd(reason, { note: `${reason} happened` }));
    assert.equal(result.decision.verdict, "infra-error");
    assert.equal(result.errorClass, ERROR_CLASS.INFRA);
    assert.equal(result.note, `${reason} happened`);
    assert.equal(result.outcome, undefined);
    assert.deepEqual(calls.order, ["prune"]);
  });
}

test("a change the classifier skipped is a skipped run that records nothing and prunes its working copy", async () => {
  const { result, calls } = await end(runEnd("classify-skipped"));
  assert.equal(result.decision.verdict, "skipped");
  assert.equal(result.errorClass, null);
  assert.equal(result.outcome, undefined);
  assert.deepEqual(calls.order, ["prune"]);
});

test("a declared no-op records its skip first and prunes after, and learns nothing", async () => {
  const { result, calls } = await end(runEnd("generation-noop", { note: "nothing here is worth a test", noop: { kind: "unobservable" } as never }));
  assert.equal(result.decision.verdict, "skipped");
  assert.equal(result.errorClass, null);
  assert.equal(result.note, "nothing here is worth a test");
  assert.equal(result.outcome, calls.saved[0]);
  assert.equal(calls.saved[0]!.note, "nothing here is worth a test");
  assert.deepEqual(calls.order, ["save", "prune"]);
});

test("a login that could not be completed is a recorded E-PRECONDITION that teaches nothing", async () => {
  const { result, calls } = await end(runEnd("login-precondition", { generating: true, note: "the login was rejected" }));
  assert.equal(result.decision.verdict, "infra-error");
  assert.equal(result.errorClass, ERROR_CLASS.PRECONDITION);
  assert.equal(result.note, "the login was rejected");
  assert.equal(calls.saved.length, 1);
  assert.equal(calls.folded.length, 0);
  assert.equal(calls.reflected, 0);
  assert.deepEqual(calls.order, ["prune", "save"]);
});

for (const [generationEnd, errorClass, teaches] of [
  [GENERATION_END.UNDECIDED_EMPTY, ERROR_CLASS.NO_DECISION, false],
  [GENERATION_END.EXHAUSTED, ERROR_CLASS.STEP_BUDGET, true],
  [GENERATION_END.TIME_BUDGET, ERROR_CLASS.TIME_BUDGET, false],
] as const) {
  test(`a generation that ended ${generationEnd} without specs is a recorded ${errorClass}${teaches ? " that teaches" : " that teaches nothing"}`, async () => {
    const { result, calls } = await end(runEnd("generation-ended-without-specs", { generationEnd, note: "no specs", ...EVIDENCE }));
    assert.equal(result.decision.verdict, "infra-error");
    assert.equal(result.errorClass, errorClass);
    assert.equal(result.note, "no specs");
    assert.deepEqual(result.rulesRetrieved, ["rule-1"]);
    assert.equal(calls.saved.length, 1);
    assert.equal(calls.folded.length, teaches ? 1 : 0);
    assert.equal(calls.reflected, teaches ? 1 : 0);
    assert.equal(calls.published.length, 0);
  });
}

test("a static gate that refused the specs opens an Issue, records the run as E-STATIC and learns from it", async () => {
  const { result, calls } = await end(runEnd("static-gate-failed", { generating: true, note: "[lint] no-wait-for-timeout", ...EVIDENCE }));
  assert.equal(result.decision.verdict, "invalid");
  assert.equal(result.decision.sideEffect, "issue");
  assert.equal(result.errorClass, "E-STATIC");
  assert.equal(result.note, "[lint] no-wait-for-timeout\n\nissue #7 opened");
  assert.equal(calls.published.length, 1);
  assert.equal(calls.saved.length, 1);
  assert.equal(calls.folded.length, 1);
  assert.deepEqual(calls.order, ["publish", "prune", "save", "fold", "reflect", "audit"]);
});

test("a static gate that refused the specs of a context run opens its Issue and records nothing", async () => {
  const { result, calls } = await end(runEnd("static-gate-failed", { generating: true, note: "[manifest] unreadable" }), { mode: "context" });
  assert.equal(result.decision.verdict, "invalid");
  assert.equal(result.decision.sideEffect, "issue");
  assert.equal(result.errorClass, null);
  assert.equal(result.outcome, undefined);
  assert.deepEqual(result.rulesRetrieved, []);
  assert.equal(result.note, undefined);
  assert.equal(calls.published.length, 1);
  assert.equal(calls.saved.length, 0);
  assert.equal(calls.folded.length, 0);
  assert.deepEqual(calls.order, ["publish", "prune"]);
});

test("a run that could not reach execution is a recorded infra-error that publishes and learns nothing", async () => {
  const { result, calls } = await end(runEnd("pre-execute-infra", { generating: true, note: "DEV went down mid-run", ...EVIDENCE }));
  assert.equal(result.decision.verdict, "infra-error");
  assert.equal(result.errorClass, ERROR_CLASS.INFRA);
  assert.equal(result.note, "DEV went down mid-run");
  assert.equal(calls.published.length, 0);
  assert.equal(calls.saved.length, 1);
  assert.equal(calls.folded.length, 0);
});

test("a run whose login failed before execute is a recorded E-PRECONDITION", async () => {
  const { result } = await end(runEnd("pre-execute-infra", { generating: true, note: "the login was rejected", preconditionFailed: true }));
  assert.equal(result.errorClass, ERROR_CLASS.PRECONDITION);
});

test("a reviewer that could not be reached is a recorded E-REVIEWER-UNAVAILABLE naming its reason, with nothing published or learned", async () => {
  const { result, calls } = await end(runEnd("reviewer-unavailable", { rationale: "the reviewer session failed", passedCases: 3, static: true, ...EVIDENCE }));
  assert.equal(result.decision.verdict, "infra-error");
  assert.equal(result.decision.sideEffect, "none");
  assert.equal(result.errorClass, ERROR_CLASS.REVIEWER_UNAVAILABLE);
  assert.match(result.note ?? "", /reviewer was unavailable \(the reviewer session failed\).*3 case\(s\)/);
  assert.equal(calls.saved[0]!.gateSignals.reviewerRationale, "the reviewer session failed");
  assert.equal(calls.saved[0]!.gateSignals.static, true);
  assert.equal(calls.published.length, 0);
  assert.equal(calls.folded.length, 0);
  assert.equal(calls.audited, 1, "its recurrence is an operating signal the audit alone sees");
});

test("an unsettled review dispute is a recorded E-REVIEW-DISPUTED carrying the finding and its rebuttal", async () => {
  const disputed = [{ finding: "[wrong-objective] the discount is never asserted", rebuttal: { finding: "x", basis: "execution", ref: "a.spec.ts", reason: "the case passed" } }] as never;
  const { result, calls } = await end(runEnd("review-disputed", { disputed, passedCases: 2, static: true, ...EVIDENCE }));
  assert.equal(result.errorClass, ERROR_CLASS.REVIEW_DISPUTED);
  assert.match(result.note ?? "", /could not settle 1 finding\(s\).*the discount is never asserted.*the case passed/);
  assert.equal(calls.published.length, 0);
  assert.equal(calls.folded.length, 0);
});

test("a spent run deadline is a recorded E-TIME-BUDGET with the budget's note, published and learned nowhere", async () => {
  const { result, calls } = await end(runEnd("run-deadline", { note: "the run budget (diff-tiny) was spent", generationEnd: GENERATION_END.TIME_BUDGET, rulesRetrieved: ["rule-1"] }));
  assert.equal(result.decision.verdict, "infra-error");
  assert.equal(result.errorClass, ERROR_CLASS.TIME_BUDGET);
  assert.equal(result.note, "the run budget (diff-tiny) was spent");
  assert.deepEqual(result.rulesRetrieved, ["rule-1"]);
  assert.equal(calls.saved.length, 1);
  assert.equal(calls.published.length, 0);
  assert.equal(calls.folded.length, 0);
});

for (const reason of ["sandbox-unavailable", "probe-sweep-failed"] as const) {
  test(`${reason} is a recorded infra-error carrying its note`, async () => {
    const { result, calls } = await end(runEnd(reason, { note: `${reason} note` }));
    assert.equal(result.decision.verdict, "infra-error");
    assert.equal(result.note, `${reason} note`);
    assert.equal(calls.saved.length, 1);
    assert.equal(calls.published.length, 0);
    assert.equal(calls.folded.length, 0);
  });
}

/* A decided run: the context it ends in has a working copy, services and the state the phases left. */
function decidedRun(opts: { verdict: "pass" | "fail"; mode?: RunQaInput["mode"]; shadow?: boolean; reviewerApproved?: boolean; publishFails?: boolean; config?: Partial<RunQaConfig> }) {
  const { ctx, calls } = context({ mode: opts.mode ?? "diff", config: { shadow: opts.shadow ?? false, ...opts.config } });
  const run = { verdict: opts.verdict, cases: [{ name: "case", status: opts.verdict === "pass" ? "pass" : "fail" }], logs: "log text" };
  const state = initialRunState();
  state.execution = { ...state.execution, run: run as never, validation: { ok: true, errors: [] } as never, lastGenerated: { specMetas: [] } as never };
  state.review = { ...state.review, reviewerApproved: opts.reviewerApproved ?? true };
  state.grounding = { ...state.grounding, retrievedRuleIds: ["rule-1"] };
  const evidence: RunEvidence = {
    verdict: opts.verdict,
    generating: true,
    needsReview: ctx.cfg.needsReview && ctx.input.mode !== "context",
    reviewerApproved: state.review.reviewerApproved,
    blocksPublish: false,
    shadow: ctx.cfg.shadow,
    onFailure: ctx.cfg.onFailure,
  };
  const decision = decide(evidence);
  state.decided = { evidence, decision, isContextCleanPass: ctx.input.mode === "context" && decision.verdict === "pass" };
  const services = { confinement: { enforce: async () => { calls.order.push("enforce"); }, add: () => {}, totals: undefined }, proofBytes: new Map(), integrityCounters: { acceptances: 0, rejected: 0, capHit: false }, intentLock: { mode: "signal" }, intentState: { clauses: 0, violations: 0, wouldReject: 0, opaque: 0, opacityHigh: false } };
  const wctx = { ...ctx, workspace: fakeHandle({ mirrorDir: MIRROR, specDir: `${MIRROR}/e2e` }), services } as unknown as WorkspaceRunContext;
  if (opts.publishFails) (wctx.deps.publication as { publish: unknown }).publish = async () => { calls.order.push("publish"); throw new Error("the forge is down"); };
  return { ctx: wctx, state, calls };
}

test("a decided green run opens its pull request after the last confinement pass, prunes, saves its record and folds it, which a pass does without reflecting", async () => {
  const { ctx, state, calls } = decidedRun({ verdict: "pass" });
  const result = await finalizeRun(runEnd("decided"), ctx, state);
  assert.equal(result.decision.verdict, "pass");
  assert.equal(result.decision.sideEffect, "pr");
  assert.equal(result.note, "issue #7 opened");
  assert.deepEqual(result.rulesRetrieved, ["rule-1"]);
  assert.equal(result.outcome, calls.saved[0]);
  assert.deepEqual(calls.order, ["enforce", "publish", "prune", "save", "fold"]);
  assert.equal(calls.done, 1);
});

test("a decided run whose reviewer rejected the green suite opens an Issue and teaches nothing a pass would", async () => {
  const { ctx, state, calls } = decidedRun({ verdict: "pass", reviewerApproved: false });
  const result = await finalizeRun(runEnd("decided"), ctx, state);
  assert.equal(result.decision.sideEffect, "issue");
  assert.equal(calls.published.length, 1);
  assert.equal(calls.saved.length, 1);
});

test("a decided run in shadow mode still publishes through the port, which logs instead of opening anything", async () => {
  const { ctx, state, calls } = decidedRun({ verdict: "pass", shadow: true });
  const result = await finalizeRun(runEnd("decided"), ctx, state);
  assert.equal(result.decision.sideEffect, "shadow-log");
  assert.equal(calls.published.length, 1);
  assert.equal(calls.saved.length, 1);
});

test("a decided run with nothing to publish still prunes and records", async () => {
  const { ctx, state, calls } = decidedRun({ verdict: "pass", config: { needsReview: false }, mode: "diff" });
  state.classification.generating = false;
  state.decided = { ...state.decided!, decision: decide({ ...state.decided!.evidence, generating: false }) };
  const result = await finalizeRun(runEnd("decided"), ctx, state);
  assert.equal(result.decision.sideEffect, "none");
  assert.equal(calls.published.length, 0);
  assert.deepEqual(calls.order.slice(0, 3), ["enforce", "prune", "save"]);
  assert.equal(result.note, undefined);
});

test("a clean context pass publishes its map, persists nothing and reports no retrieved rules or static pass", async () => {
  const { ctx, state, calls } = decidedRun({ verdict: "pass", mode: "context" });
  const result = await finalizeRun(runEnd("context-pass"), ctx, state);
  assert.equal(result.outcome, undefined);
  assert.deepEqual(result.rulesRetrieved, []);
  assert.equal(result.gateSignals.static, false);
  assert.equal(calls.saved.length, 0);
  assert.equal(calls.folded.length, 0);
  assert.equal(calls.order.includes("prune"), true);
});

test("a publication that throws after the verdict keeps the decided verdict, records the run with the failure as its note and learns from it", async () => {
  const { ctx, state, calls } = decidedRun({ verdict: "pass", publishFails: true });
  const result = await finalizeRun(runEnd("decided"), ctx, state);
  assert.equal(result.decision.verdict, "pass");
  assert.match(result.note ?? "", /publication failed after verdict was decided \(decided: pass, reviewerApproved: true\): the forge is down/);
  assert.equal(calls.saved.length, 1);
  assert.equal(calls.saved[0]!.verdict, "pass");
  assert.equal(calls.saved[0]!.note, result.note);
  assert.equal(calls.folded.length, 1);
  assert.deepEqual(calls.order, ["enforce", "publish", "prune", "save", "fold"]);
});

test("a run cannot be decided before its working copy is prepared", async () => {
  const { ctx } = context();
  await assert.rejects(finalizeRun(runEnd("decided"), ctx, initialRunState()), /before its working copy is prepared/);
});

test("an error nothing handles leaves the evidence of its sandbox as a recorded infra-error that nothing learns from", async () => {
  const { ctx, calls, state } = context();
  await recordCrashEvidence("The run ended on TypeError before it reached a verdict; only what the sandbox saw is kept here.", ctx, state);
  assert.equal(calls.saved.length, 1);
  assert.match(calls.saved[0]!.note ?? "", /ended on TypeError/);
  assert.equal(calls.published.length, 0);
  assert.equal(calls.folded.length, 0);
  assert.deepEqual(calls.order, ["prune", "save"]);
});

test("every end reason has a row of effects, and the effects of a recorded end publish only what its decision calls for", () => {
  assert.deepEqual(Object.keys(END_EFFECTS).sort(), [...END_REASONS].sort());
});

/* The effects table is the run-end table in code: what a whole run observed of each end is what its reason says it does. */
for (const row of RUN_END_ROWS) {
  if (!row.endReason) continue;
  const reason: EndReason = row.endReason;
  test(`the effects of ${reason} agree with the run-end row ${row.id}`, () => {
    const effects = END_EFFECTS[reason];
    const rig = newRig();
    try {
      row.setup(rig);
      const mode = rig.input.mode ?? "diff";
      const persists = effects.persist === "yes" || (effects.persist === "not-in-context-mode" && mode !== "context");
      assert.equal(row.expect.persisted, persists, "persisted");
      if (row.expect.publishCalled) assert.equal(effects.publish, "decision", "a run that dispatched publication ends for a reason that may");
      if (effects.publish === "none") assert.equal(row.expect.published, "none", "published");
      if (row.expect.folded || row.expect.reflected) assert.notEqual(effects.learn, "none", "learned");
      if (effects.learn === "none") assert.equal(row.expect.folded || row.expect.reflected, false, "learned");
      if (effects.learn === "mainline") assert.equal(reason, "decided");
    } finally {
      dispose(rig);
    }
  });
}
