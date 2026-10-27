/* A run that generates asks its lead for a plan and the coordinator authors the flows; what it hands back is read like any generation. A run the coordinator hands back to the lead, or one with no coordinator wired, is authored by the lead alone. */

import { pageCandidate } from "../../../support/use-case-candidate.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ERROR_CLASS } from "@kernel/error-class.ts";
import { loginToBeWritten } from "../../../support/coordinator-over-author.ts";
import { ok } from "@kernel/result.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { AUTHORING_REFUSAL, DEFAULT_COORDINATION_SETTINGS, type CoordinationGateSignal } from "@kernel/coordination.ts";
import { PLAN_DOWNGRADE } from "@contexts/coordination/application/lead-plan.ts";
import { RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { RunQaUseCase, type RunQaInput, type RunQaUseCaseDeps } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import type { CoordinateInput, CoordinateResult, CoordinatedPass, PassCorrection } from "@contexts/coordination/application/lead-sidekicks.ts";
import { CORRECTION_ORIGIN, type CorrectionOrigin, type CorrectionFinding } from "@contexts/coordination/application/lead-correction.ts";
import type { AgentBrowserHandle, ClosedLoopHandle } from "@contexts/agent-tools/application/index.ts";
import type { GenerationEnrichment, ReviewEnrichment } from "@contexts/generation/application/index.ts";
import type { PlanOutput } from "@kernel/plan-output.ts";
import { leadCorrectionBudget } from "@contexts/run-orchestration/domain/lead-correction-budget.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace, type RunWorkspace } from "../../../support/run-workspace.ts";
import { fakeWorkspace } from "./run-flow/fake-workspace.ts";
import { confinedSpecFiles } from "../../../../src/shared-infrastructure/spec-files.adapter.ts";
import { primaryChangeSet } from "../../../support/change-set.ts";
const INPUT: RunQaInput = { app: "demo", changeSet: primaryChangeSet("demo", Sha.of("abc1234")), sha: Sha.of("abc1234"), source: "manual", mode: "diff", target: "e2e", runId: "coord-run" };
const PASS: QaCase[] = [{ name: "a", status: "pass", file: "flows/a.spec.ts" }];

const signalOf = (over: Partial<CoordinationGateSignal> = {}): CoordinationGateSignal => ({ flows: 0, delivered: 0, incomplete: 0, ...over });

interface Rig {
  calls: string[];
  enrichments: GenerationEnrichment[];
  planned: GenerationEnrichment[];
  coordinated: CoordinateInput[];
  saved: RunOutcome[];
  validated: number;
  ws: RunWorkspace;
  deps(over?: Partial<RunQaUseCaseDeps>): RunQaUseCaseDeps;
}

const authored = (specs: string[] = ["flows/a.spec.ts"]): CoordinateResult => ({ action: "fanout", aggregated: { end: GENERATION_END.DELIVERED, specs, incompleteFlows: [] }, proposals: [], signal: signalOf({ plan: "fanout", flows: specs.length, delivered: specs.length }) });
const refused = (refusal: string): CoordinateResult => ({ action: "refused", refusal, reason: "no sidekick can author", signal: signalOf({ refusal }) });

function rig(result: () => Promise<CoordinateResult> | CoordinateResult = () => authored()): Rig {
  const ws = runWorkspace("qa-coord-");
  const calls: string[] = [];
  const r: Rig = { calls, enrichments: [], planned: [], coordinated: [], saved: [], validated: 0, ws, deps: undefined as never };
  const closedLoop: ClosedLoopHandle = {
    limits: { maxCalls: 8, perCallMs: 120_000, maxDevWrites: 20 },
    openFlow: () => undefined,
    sweepProbes: async () => void calls.push("sweep"),
    isClosed: async () => false,
    signals: () => ({ calls: 0, devWrites: 0 }),
    close: async () => void calls.push("close-loop"),
  };
  const agentBrowser: AgentBrowserHandle = { limits: { maxCalls: 60, perCallMs: 30_000, leaseWaitMs: 15_000 }, grantShare: () => {}, readsOf: () => [], signals: () => ({ calls: 0, blocks: 0, invalidations: 0, renewals: 0 }), close: async () => {} };
  r.deps = (over = {}) => {
    const { generation: generationOver, ...rest } = over;
    return {
    changeAnalysis: { classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "the diff" }) },
    generation: generationOnDisk(generationOver ?? {
      author: async (_d, _s, _diff, enrichment) => {
        calls.push("generate");
        r.enrichments.push(enrichment ?? {});
        return scriptedGeneration({ specs: ["flows/a.spec.ts"]});
      },
      plan: async (_dir, _signal, _diff, enrichment): Promise<PlanOutput> => {
        calls.push("plan");
        r.planned.push(enrichment);
        return { plan: { kind: "lead" }, parsed: true, timedOut: false };
      },
    }),
    review: { review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }) },
    validation: { validate: async () => (r.validated++, calls.push("validate"), { ok: true, errors: [] }) },
    execution: { execute: async () => (calls.push("execute"), { verdict: "pass", cases: PASS, logs: "" }) },
    objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
    publication: { publish: async () => ({ outcome: "pr" }) },
    learning: { fold: async () => {}, retrieve: async () => [] },
    workspace: fakeWorkspace(ws),
    specFiles: confinedSpecFiles,
    suiteStore: ws.suiteStore,
    deployGate: { waitUntilServing: async () => ok(true) },
    runHistory: { save: async (outcome) => void r.saved.push(outcome) },
    confinement: { enforce: async () => (calls.push("confine"), { strays: 0, dangerous: 0, reverted: [] }) },
    closedLoop: { open: async () => closedLoop },
    agentBrowser: { open: async () => agentBrowser },
    leadSidekicks: { coordinate: async (input) => {
      calls.push("coordinate");
      r.coordinated.push(input);
      const coordinated = await result();
      if (coordinated.action === "fanout") {
        for (const spec of coordinated.aggregated.specs) if (spec.endsWith(".spec.ts") && !ws.has(spec)) ws.write(spec);
      }
      return coordinated;
    } },
    authContext: { baseUrl: "https://dev", auth: { kind: "form", usernameEnv: "U", passwordEnv: "P" } },
    config: { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: false },
    ...rest,
    };
  };
  return r;
}

test("a run with no coordinator ends infra-error E-NO-AUTHOR (no-coordinator) and no author is ever asked", async () => {
  const bare = rig();
  const out = await new RunQaUseCase(bare.deps({ leadSidekicks: undefined })).run(INPUT);
  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.errorClass, ERROR_CLASS.NO_AUTHOR);
  assert.match(out.note ?? "", new RegExp(AUTHORING_REFUSAL.NO_COORDINATOR));
  assert.equal(bare.coordinated.length, 0);
  assert.equal(bare.planned.length, 0);
  assert.deepEqual(bare.calls.filter((c) => c === "generate"), [], "the author is never asked");
});

test("a run with no coordinator records the refusal, and a coordinated one records what became of it", async () => {
  const bare = rig();
  const plain = await new RunQaUseCase(bare.deps({ leadSidekicks: undefined })).run(INPUT);
  assert.equal(plain.outcome?.gateSignals.coordination?.refusal, AUTHORING_REFUSAL.NO_COORDINATOR);

  const coordinated = rig(() => ({ ...authored(), signal: signalOf({ plan: "fanout", flows: 1, delivered: 1, authoring: "authenticated-browser" }) }));
  const out = await new RunQaUseCase(coordinated.deps()).run(INPUT);
  assert.deepEqual(out.outcome?.gateSignals.coordination, signalOf({ plan: "fanout", flows: 1, delivered: 1, authoring: "authenticated-browser" }));
});

test("a coordinated run hands the coordinator what the run knows: its identity, the grants, the login and the planning turn", async () => {
  const r = rig();
  await new RunQaUseCase(r.deps()).run(INPUT);
  const [input] = r.coordinated;
  assert.equal(input!.runId, "coord-run");
  assert.equal(input!.app, "demo");
  assert.equal(input!.mirrorDir, r.ws.mirrorDir);
  assert.equal(input!.specDir, r.ws.specDir);
  assert.equal(input!.specRelDir, "e2e");
  assert.deepEqual(input!.facts, { hasLogin: true });
  assert.ok(input!.closedLoop && input!.agentBrowser, "both grants");
  assert.deepEqual(input!.settings, DEFAULT_COORDINATION_SETTINGS);
  /* The planning closure asks the generation port, with the run's enrichment and the limits. */
  const planned = await input!.plan!({ capacity: 4, maxParallel: 2, budgetMs: 60_000 });
  assert.equal(planned.parsed, true);
  assert.deepEqual(r.planned[0]!.planning, { capacity: 4, maxParallel: 2, budgetMs: 60_000 });
  assert.equal(r.planned[0]!.runId, "coord-run");
  assert.ok(r.planned[0]!.closedLoop && r.planned[0]!.agentBrowser, "the plan turn is told the tool budgets like any generation");
});

test("the change's candidates reach the coordinator, and a run that derived none passes none", async () => {
  const candidates = [pageCandidate("/order", ["src/order.ts::place", "page /order"]), pageCandidate("/upload-menu")];
  const withScope = rig();
  const changeScope = { resolve: async () => ({ repos: [], reach: [], hubs: [], disagreements: [], omitted: 0, degraded: [] }), candidates: async () => candidates };
  await new RunQaUseCase(withScope.deps({ changeScope })).run(INPUT);
  assert.deepEqual(withScope.coordinated[0]!.candidates, candidates);
  const plain = rig();
  await new RunQaUseCase(plain.deps({ changeScope: { ...changeScope, candidates: async () => [] } })).run(INPUT);
  assert.equal(plain.coordinated[0]!.candidates, undefined);
});

test("a generation that cannot plan is told to the coordinator as no planning turn", async () => {
  const r = rig();
  await new RunQaUseCase(r.deps({ generation: { author: async () => scriptedGeneration({ specs: ["flows/a.spec.ts"]}) } })).run(INPUT);
  assert.equal(r.coordinated[0]!.plan, undefined);
});

test("a run with no login is told to the coordinator as one", async () => {
  const r = rig();
  await new RunQaUseCase(r.deps({ authContext: undefined })).run(INPUT);
  assert.equal(r.coordinated[0]!.facts.hasLogin, false);
});

test("flows that were authored are the run's specs: the lead generates nothing, the probes are swept, and the working copy is judged as for any generation", async () => {
  const r = rig(() => ({
    action: "fanout",
    aggregated: { end: GENERATION_END.DELIVERED, specs: ["flows/a.spec.ts", "flows/b.spec.ts"], incompleteFlows: [{ id: "c", kind: "failed" }] },
    proposals: [],
    signal: signalOf({ plan: "fanout", flows: 3, delivered: 2, incomplete: 1 }),
  }));
  const out = await new RunQaUseCase(r.deps()).run(INPUT);
  assert.equal(r.calls.includes("generate"), false, "the lead did not generate");
  assert.ok(r.calls.indexOf("sweep") < r.calls.indexOf("validate"), "the probes of the flows' loops are swept before the gate sees the working copy");
  assert.ok(r.calls.indexOf("confine") < r.calls.indexOf("validate"));
  assert.equal(r.calls.includes("execute"), true);
  assert.equal(out.outcome?.gateSignals.coordination?.delivered, 2);
  assert.equal(out.outcome?.gateSignals.coordination?.incomplete, 1);
  assert.equal(out.decision.verdict, "pass");
});

test("a coordinator that refuses ends the run infra-error E-NO-AUTHOR with the refusal recorded, and the generator is never asked", async () => {
  for (const refusal of [AUTHORING_REFUSAL.CANNOT_PLAN, AUTHORING_REFUSAL.NO_AUTHOR_GRANT, AUTHORING_REFUSAL.NO_TIME, AUTHORING_REFUSAL.PLAN_TIMED_OUT, ...Object.values(PLAN_DOWNGRADE).map((reason) => `${AUTHORING_REFUSAL.PLAN_REJECTED}:${reason}`)]) {
    const r = rig(() => refused(refusal));
    const out = await new RunQaUseCase(r.deps()).run(INPUT);
    assert.equal(out.decision.verdict, "infra-error", refusal);
    assert.equal(out.errorClass, "E-NO-AUTHOR", refusal);
    assert.equal(out.outcome?.gateSignals.coordination?.refusal, refusal);
    assert.match(out.note ?? "", new RegExp(refusal));
    assert.equal(r.calls.includes("generate"), false, `${refusal}: the generator is never asked`);
    assert.equal(r.calls.includes("execute"), false, refusal);
    assert.equal(out.outcome?.errorClass, "E-NO-AUTHOR", refusal);
  }
});

test("a lead that declared a no-op in its plan ends the run as the declared no-op does: skipped, with its reason, and nothing is run", async () => {
  const r = rig(() => ({ action: "noop", reason: "docs only", signal: signalOf({ plan: "noop" }) }));
  const out = await new RunQaUseCase(r.deps()).run(INPUT);
  assert.equal(out.decision.verdict, "skipped");
  assert.equal(out.note, "docs only");
  assert.equal(r.calls.includes("generate") || r.calls.includes("validate") || r.calls.includes("execute"), false);
});

test("flows that decided nothing or ran out of time end the run on the class their end names, never as an empty result", async () => {
  for (const [end, errorClass] of [[GENERATION_END.UNDECIDED_EMPTY, "E-NO-DECISION"], [GENERATION_END.TIME_BUDGET, "E-TIME-BUDGET"]] as const) {
    const r = rig(() => ({ action: "fanout", aggregated: { end, specs: [], incompleteFlows: [], note: "nothing finished" }, proposals: [], signal: signalOf({ plan: "fanout", flows: 2 }) }));
    const out = await new RunQaUseCase(r.deps()).run(INPUT);
    assert.equal(out.decision.verdict, "infra-error", end);
    assert.equal(out.errorClass, errorClass, end);
    assert.equal(r.calls.includes("execute"), false);
  }
});

test("coordination asks for nothing from a code run, a context run, a regression run or a login the lead still has to write", async () => {
  const code = rig();
  await new RunQaUseCase(code.deps({ config: { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: true } })).run({ ...INPUT, target: "code" });
  assert.equal(code.coordinated.length, 0, "code");

  const context = rig();
  await new RunQaUseCase(context.deps({ generation: { author: async () => scriptedGeneration({ specs: [".qa/context.json"], note: "map" }) } })).run({ ...INPUT, mode: "context" });
  assert.equal(context.coordinated.length, 0, "context");

  const regression = rig();
  await new RunQaUseCase(regression.deps({ changeAnalysis: { classify: async () => ({ action: "regression", reason: "no source change", diff: "" }) } })).run(INPUT);
  assert.equal(regression.coordinated.length, 0, "regression");

  const unauthored = rig();
  await new RunQaUseCase(unauthored.deps({ authSession: { prepare: async () => ({ unauthored: true }) } })).run(INPUT);
  assert.equal(unauthored.coordinated.length, 0, "a login still to write");
});

test("a login still to be written is authored by one author sidekick with no plan, whether or not a coordinator is wired", async () => {
  const r = rig();
  await new RunQaUseCase(r.deps({ ...loginToBeWritten(), leadSidekicks: undefined })).run(INPUT);
  assert.equal(r.calls.filter((c) => c === "generate").length, 1);
  assert.equal(r.calls.includes("plan"), false);
  assert.equal(r.coordinated.length, 0);
});

test("a coordinator that fails ends the run E-NO-AUTHOR (coordination-failed) and the failure is recorded", async () => {
  const r = rig(() => { throw new Error("workspace volume full"); });
  const out = await new RunQaUseCase(r.deps()).run(INPUT);
  assert.equal(r.calls.includes("generate"), false, "the lead authors nothing in its place");
  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.errorClass, "E-NO-AUTHOR");
  assert.equal(out.outcome?.gateSignals.coordination?.refusal, AUTHORING_REFUSAL.COORDINATION_FAILED);
  assert.match(out.note ?? "", /workspace volume full/);
});

test("the end of the run's own time reaches the run as it does from any agent turn", async () => {
  const r = rig(() => { throw new RunDeadlineExceededError(60_000, "diff", "sidekick", "mid-turn"); });
  const out = await new RunQaUseCase(r.deps()).run(INPUT);
  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.errorClass, "E-TIME-BUDGET");
  assert.equal(r.calls.includes("generate"), false);
});

test("a run cancelled while its flows were being authored is a cancelled run, not a result", async () => {
  const controller = new AbortController();
  const r = rig(() => { controller.abort(); return { action: "fanout", aggregated: { end: GENERATION_END.DELIVERED, specs: ["flows/a.spec.ts"], incompleteFlows: [] }, proposals: [], signal: signalOf({ plan: "fanout" }) }; });
  const out = await new RunQaUseCase(r.deps()).run(INPUT, controller.signal);
  assert.equal(r.calls.includes("validate"), false);
  assert.equal(out.decision.verdict, "infra-error");
});


test("a run cancelled while its plan was being refused is a cancelled run, not an E-NO-AUTHOR result", async () => {
  const controller = new AbortController();
  const r = rig(() => { controller.abort(); return refused(AUTHORING_REFUSAL.PLAN_TIMED_OUT); });
  const out = await new RunQaUseCase(r.deps()).run(INPUT, controller.signal);
  assert.notEqual(out.errorClass, "E-NO-AUTHOR");
  assert.equal(r.calls.includes("validate"), false);
});

/* A coordinated pass kept open: it records what it was asked to correct and how many times it was released, and corrects as told. */
function keptPass(r: Rig, answer: (findings: readonly CorrectionFinding[]) => PassCorrection) {
  const seen = { corrected: [] as CorrectionFinding[][], origins: [] as CorrectionOrigin[], released: 0, left: [] as Array<{ count: number; origin: CorrectionOrigin; reason: string }> };
  const pass: CoordinatedPass = {
    correct: async (findings, origin = CORRECTION_ORIGIN.REVIEW) => {
      seen.corrected.push([...findings]);
      seen.origins.push(origin);
      const out = answer(findings);
      for (const spec of out.specs) r.ws.write(spec, `// corrected ${spec}\n`);
      return out;
    },
    leaveUnrouted: (findings, origin, reason) => void seen.left.push({ count: findings.length, origin, reason }),
    tally: () => ({ turns: seen.corrected.length, routed: seen.corrected.flat().length, unrouted: 0, revised: seen.corrected.length, replaced: 0, rebutted: 0 }),
    release: async () => void (seen.released += 1),
  };
  return { pass, seen };
}

/* A reviewer that rejects its first round with these findings and approves the next. */
function rejectingOnce(corrections: string[]) {
  let round = 0;
  return { review: async () => (round++ === 0 ? { approved: false, corrections, blockingCount: corrections.length, parsed: true } : { approved: true, corrections: [], blockingCount: 0, parsed: true }) };
}

const delivered = (pass: CoordinatedPass): CoordinateResult => ({ action: "fanout", aggregated: { end: GENERATION_END.DELIVERED, specs: ["flows/a.spec.ts"], incompleteFlows: [] }, proposals: [], signal: signalOf({ plan: "fanout", flows: 1, delivered: 1 }), pass });

test("in a coordinated run the reviewer's corrections go to the lead's pass, not to a regeneration, and the pass is released once the review ends", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: ["flows/a.spec.ts"], rebuttals: [], unrouted: [] }));
  const result = await new RunQaUseCase(r.deps({ review: rejectingOnce(["flows/a.spec.ts never asserts the total"]) })).run(INPUT);
  assert.deepEqual(kept.seen.corrected, [[{ text: "flows/a.spec.ts never asserts the total" }]]);
  assert.equal(r.calls.filter((c) => c === "generate").length, 0, "no regeneration of its own");
  assert.equal(kept.seen.released, 1);
  assert.equal(result.outcome?.verdict, "pass");
  assert.deepEqual(result.outcome?.gateSignals.coordination?.corrections, { turns: 1, routed: 1, unrouted: 0, revised: 1, replaced: 0, rebutted: 0 });
});

test("the corrections a coordinated run routes through the lead are recorded and stay within the lead's budget", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: ["flows/a.spec.ts"], rebuttals: [], unrouted: [] }));
  const result = await new RunQaUseCase(r.deps({ review: rejectingOnce(["flows/a.spec.ts never asserts the total"]) })).run(INPUT);
  const turns = result.outcome?.gateSignals.coordination?.corrections?.turns ?? 0;
  assert.equal(turns, kept.seen.corrected.length);
  assert.ok(turns > 0 && turns <= leadCorrectionBudget({ maxRetries: 2 }));
});

test("a finding no flow was sent is not regenerated by a cold author: it stays unrouted and the round goes on with what the flows delivered", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: [], rebuttals: [], unrouted: [0] }));
  const result = await new RunQaUseCase(r.deps({ review: rejectingOnce(["a loose finding"]) })).run(INPUT);
  assert.deepEqual(kept.seen.corrected, [[{ text: "a loose finding" }]], "the lead is asked");
  assert.equal(r.enrichments.filter((e) => e.reviewCorrections !== undefined).length, 0, "no author was sent the finding");
  assert.equal(r.calls.filter((c) => c === "generate").length, 0);
  assert.equal(kept.seen.released, 1);
  assert.ok(result.outcome, "the run still ends with an outcome");
});

test("a code run and a context run are authored by one author sidekick, with no plan, and the working copy is confined after it", async () => {
  const code = rig();
  await new RunQaUseCase(code.deps({ config: { needsReview: false, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: true } })).run({ ...INPUT, target: "code" });
  assert.equal(code.coordinated.length, 0);
  assert.deepEqual(code.calls.filter((c) => c === "generate" || c === "plan"), ["generate"]);
  assert.ok(code.calls.indexOf("confine") > code.calls.indexOf("generate"), "confinement follows the author's turn");

  const context = rig();
  await new RunQaUseCase(context.deps()).run({ ...INPUT, mode: "context" });
  assert.equal(context.coordinated.length, 0);
  assert.deepEqual(context.calls.filter((c) => c === "generate" || c === "plan"), ["generate"]);
  assert.ok(context.calls.indexOf("confine") > context.calls.indexOf("generate"));
});

test("a pass whose flows delivered nothing is released at once and never asked to correct", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => ({ action: "fanout", aggregated: { end: GENERATION_END.UNDECIDED_EMPTY, specs: [], incompleteFlows: [], note: "nothing finished" }, proposals: [], signal: signalOf({ plan: "fanout", flows: 1 }), pass: kept.pass }));
  kept = keptPass(r, () => ({ readable: true, specs: [], rebuttals: [], unrouted: [] }));
  await new RunQaUseCase(r.deps()).run(INPUT);
  assert.equal(kept.seen.released, 1);
  assert.deepEqual(kept.seen.corrected, []);
});

test("a pass is released however the run ends, a run that throws after coordinating included", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: [], rebuttals: [], unrouted: [] }));
  await assert.rejects(new RunQaUseCase(r.deps({ validation: { validate: async () => { throw new Error("validator down"); } } })).run(INPUT));
  assert.equal(kept.seen.released, 1);
});

test("a pass is released once nothing can correct through it, before the run publishes, even when the review never runs", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: [], rebuttals: [], unrouted: [] }));
  const release = kept.pass.release;
  kept.pass.release = async () => { r.calls.push("release"); await release(); };
  await new RunQaUseCase(r.deps({
    execution: { execute: async () => ({ verdict: "fail", cases: [], logs: "boom" }) },
    publication: { publish: async () => (r.calls.push("publish"), { outcome: "issue" }) },
  })).run(INPUT);
  assert.equal(kept.seen.released, 1);
  assert.ok(r.calls.includes("publish"), "the run published");
  assert.ok(r.calls.indexOf("release") < r.calls.indexOf("publish"), "released before publishing");
});

test("corrections the lead's pass made are recorded even when the reviewer cannot be reached afterwards", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: ["flows/a.spec.ts"], rebuttals: [], unrouted: [] }));
  const correct = kept.pass.correct;
  /* A correction that changes code, not only a comment, so the next round is judged by the model. */
  kept.pass.correct = async (findings) => { const out = await correct(findings); r.ws.write("flows/a.spec.ts", "export const total = 1;\n"); return out; };
  let round = 0;
  const review = { review: async () => (round++ === 0
    ? { approved: false, corrections: ["flows/a.spec.ts never asserts the total"], blockingCount: 1, parsed: true }
    : { approved: false, corrections: [], blockingCount: 0, parsed: false, unavailable: true }) };
  const result = await new RunQaUseCase(r.deps({ review })).run(INPUT);
  assert.equal(result.outcome?.errorClass, "E-REVIEWER-UNAVAILABLE");
  assert.deepEqual(result.outcome?.gateSignals.coordination?.corrections, { turns: 1, routed: 1, unrouted: 0, revised: 1, replaced: 0, rebutted: 0 });
  assert.equal(kept.seen.released, 1);
});

/* ── the run's own checks, after the flows were authored ─────────────────────────────────────── */

const FAILED_A: QaCase = { name: "lists the restaurants", status: "fail", file: "flows/a.spec.ts", detail: "expected 3 rows, received 0" };
const FAILED_B: QaCase = { name: "opens a restaurant", status: "fail", file: "flows/b.spec.ts", detail: "locator not found" };

/* An execution that fails with these cases first and passes every one of them from then on. */
function failingOnce(cases: QaCase[]) {
  let runs = 0;
  return { execute: async () => (runs++ === 0 ? { verdict: "fail" as const, cases, logs: "boom" } : { verdict: "pass" as const, cases: cases.map((c) => ({ name: c.name, status: "pass" as const, file: c.file! })), logs: "" }) };
}

const flowsAB = (pass: CoordinatedPass): CoordinateResult => ({ action: "fanout", aggregated: { end: GENERATION_END.DELIVERED, specs: ["flows/a.spec.ts", "flows/b.spec.ts"], incompleteFlows: [] }, proposals: [], signal: signalOf({ plan: "fanout", flows: 2, delivered: 2 }), pass });

test("in a coordinated run a failing execution goes to the lead's pass with each failing case, not to a regeneration", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: ["flows/a.spec.ts"], rebuttals: [], unrouted: [] }));
  const result = await new RunQaUseCase(r.deps({ execution: failingOnce([FAILED_A]) })).run(INPUT);
  assert.deepEqual(kept.seen.origins, [CORRECTION_ORIGIN.EXECUTION]);
  assert.equal(kept.seen.corrected[0]?.length, 1);
  assert.equal(kept.seen.corrected[0]![0]!.spec, "flows/a.spec.ts", "the finding names the spec that failed");
  assert.match(kept.seen.corrected[0]![0]!.text, /expected 3 rows, received 0/);
  assert.equal(r.calls.filter((c) => c === "generate").length, 0, "no regeneration of its own");
  assert.equal(result.outcome?.verdict, "pass");
  assert.equal(kept.seen.released, 1);
});

test("a failing case no flow takes is not regenerated by a cold author, while the case a flow took is corrected", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => flowsAB(kept.pass));
  kept = keptPass(r, (findings) => ({ readable: true, specs: ["flows/a.spec.ts"], rebuttals: [], unrouted: findings.flatMap((f, i) => (f.spec === "flows/b.spec.ts" ? [i] : [])) }));
  await new RunQaUseCase(r.deps({ execution: failingOnce([FAILED_A, FAILED_B]) })).run(INPUT);
  assert.equal(kept.seen.corrected[0]?.length, 2, "the lead is asked about both");
  assert.equal(r.enrichments.filter((e) => e.fixCases !== undefined).length, 0, "no author was sent the case");
});

test("in a coordinated run the static gate's errors go to the lead's pass, one finding per error block", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => flowsAB(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: ["flows/a.spec.ts", "flows/b.spec.ts"], rebuttals: [], unrouted: [] }));
  let checks = 0;
  const validation = { validate: async () => (checks++ === 0
    ? { ok: false, errors: ["flows/a.spec.ts(3,1): error TS2304: Cannot find name 'row'.", "flows/b.spec.ts(9,5): no-wait-for-timeout"] }
    : { ok: true, errors: [] }) };
  const result = await new RunQaUseCase(r.deps({ validation })).run(INPUT);
  assert.deepEqual(kept.seen.origins, [CORRECTION_ORIGIN.STATIC_GATE]);
  const texts = kept.seen.corrected[0]!.map((f) => f.text);
  assert.equal(texts.length, 2);
  assert.ok(texts[0]!.includes("flows/a.spec.ts") && texts[1]!.includes("flows/b.spec.ts"), "each error reaches the flow it names");
  assert.equal(r.calls.filter((c) => c === "generate").length, 0);
  assert.equal(result.outcome?.verdict, "pass");
});

test("in a coordinated run an uncovered change goes to the lead's pass, not to a regeneration", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: ["flows/a.spec.ts"], rebuttals: [], unrouted: [] }));
  let measures = 0;
  const objectiveSignal = {
    measure: async () => (measures++ === 0 ? { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/list.ts", lines: [4, 5] }] } : { status: "pass" as const, ratio: 0.9 }),
    blocks: (status: string) => status === "fail",
  };
  await new RunQaUseCase(r.deps({ objectiveSignal, config: { needsReview: false, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: false, coveragePolicyMode: "enforce" } })).run(INPUT);
  assert.deepEqual(kept.seen.origins, [CORRECTION_ORIGIN.COVERAGE]);
  assert.match(kept.seen.corrected[0]![0]!.text, /src\/list\.ts/);
  assert.equal(r.calls.filter((c) => c === "generate").length, 0);
});

test("in a coordinated run the pre-execution selector check goes to the lead's pass, naming the spec it attributed", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: ["flows/a.spec.ts"], rebuttals: [], unrouted: [] }));
  r.ws.write("flows/a.spec.ts", `await page.goto("/owners"); await page.getByTestId("ghost-id").click();`);
  const capture = async () => ({
    specFiles: ["flows/a.spec.ts"],
    specSources: [`await page.goto("/owners"); await page.getByTestId("ghost-id").click();`],
    routes: [{ route: "/owners", nodes: [], status: "captured" as const, settled: true, testIds: new Map<string, number>() }],
  });
  await new RunQaUseCase(r.deps({ preExecGrounding: { capture } })).run(INPUT);
  assert.deepEqual(kept.seen.origins, [CORRECTION_ORIGIN.PRE_EXEC]);
  assert.match(kept.seen.corrected[0]![0]!.text, /ghost-id/);
  assert.equal(kept.seen.corrected[0]![0]!.spec, "flows/a.spec.ts");
  assert.equal(r.calls.filter((c) => c === "generate").length, 0);
});

test("a run the lead authored alone regenerates for a failing execution as it always did", async () => {
  const r = rig();
  await new RunQaUseCase(r.deps({ execution: failingOnce([FAILED_A]) })).run(INPUT);
  const regen = r.enrichments.filter((e) => e.fixCases !== undefined);
  assert.deepEqual(regen.map((e) => e.fixCases!.map((c) => c.name)), [[FAILED_A.name]]);
});

test("a coverage gap reaches the lead as one finding per changed file and per untaken arm, so a number the lead cites is one item", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: ["flows/a.spec.ts"], rebuttals: [], unrouted: [] }));
  let measures = 0;
  const arm = (line: number, text: string) => ({ file: "src/list.ts", line, kind: "if", arm: text });
  const objectiveSignal = {
    measure: async () => (measures++ === 0
      ? { status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/list.ts", lines: [4, 5] }, { file: "src/detail.ts", lines: [9] }], untakenArms: [arm(4, "the else"), arm(7, "the then")] }
      : { status: "pass" as const, ratio: 0.9 }),
    blocks: (status: string) => status === "fail",
  };
  await new RunQaUseCase(r.deps({ objectiveSignal, config: { needsReview: false, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: false, coveragePolicyMode: "enforce" } })).run(INPUT);
  const texts = kept.seen.corrected[0]!.map((f) => f.text);
  assert.equal(texts.length, 4, "two files and two arms");
  assert.ok(texts[0]!.includes("src/list.ts") && /4-5/.test(texts[0]!));
  assert.ok(texts[1]!.includes("src/detail.ts"));
  assert.ok(texts[2]!.includes("src/list.ts:4") && texts[2]!.includes("the else"));
  assert.ok(texts[3]!.includes("src/list.ts:7") && texts[3]!.includes("the then"));
  assert.equal(texts.filter((t) => t.includes("the else")).length, 1, "an item is one finding only");
});

test("a run the lead authored alone still regenerates a coverage gap whole, with the gap as one text", async () => {
  const r = rig();
  const objectiveSignal = {
    measure: async () => ({ status: "fail" as const, ratio: 0.2, uncovered: [{ file: "src/list.ts", lines: [4, 5] }, { file: "src/detail.ts", lines: [9] }] }),
    blocks: (status: string) => status === "fail",
  };
  await new RunQaUseCase(r.deps({ objectiveSignal, config: { needsReview: false, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: false, coveragePolicyMode: "enforce" } })).run(INPUT);
  const gap = r.enrichments.find((e) => e.coverageGap !== undefined);
  assert.match(gap?.coverageGap ?? "", /src\/list\.ts[\s\S]*src\/detail\.ts/);
});

test("a static-gate error that spans paragraphs stays one finding", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: ["flows/a.spec.ts"], rebuttals: [], unrouted: [] }));
  let checks = 0;
  const error = "flows/a.spec.ts(3,1): error TS2322: Type 'string' is not assignable.\n\n  Expected number, received string.";
  const validation = { validate: async () => (checks++ === 0 ? { ok: false, errors: [error] } : { ok: true, errors: [] }) };
  await new RunQaUseCase(r.deps({ validation })).run(INPUT);
  assert.equal(kept.seen.corrected[0]?.length, 1);
  assert.match(kept.seen.corrected[0]![0]!.text, /Expected number, received string/);
});

/* A config whose budget of corrections through the lead is spent before the first one. */
const SPENT = { needsReview: true, shadow: false, onFailure: "github-issue" as const, maxRetries: -leadCorrectionBudget({ maxRetries: 0 }), isCode: false };

test("when the lead's correction budget is spent the static gate's errors stay unrouted and no cold author regenerates them", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: ["flows/a.spec.ts"], rebuttals: [], unrouted: [] }));
  let checks = 0;
  const validation = { validate: async () => (checks++ === 0 ? { ok: false, errors: ["flows/a.spec.ts(3,1): error TS2304: Cannot find name 'row'."] } : { ok: true, errors: [] }) };
  const result = await new RunQaUseCase(r.deps({ validation, config: SPENT })).run(INPUT);
  assert.deepEqual(kept.seen.corrected, [], "the lead is not asked");
  assert.deepEqual(kept.seen.left, [{ count: 1, origin: CORRECTION_ORIGIN.STATIC_GATE, reason: "lead correction budget spent" }]);
  assert.equal(r.calls.filter((c) => c === "generate").length, 0, "no cold regeneration");
  assert.ok(result.outcome, "the run ends with an outcome");
});

test("when the lead's correction budget is spent the reviewer's findings stay unrouted, and a run with no pass still regenerates by an author", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: ["flows/a.spec.ts"], rebuttals: [], unrouted: [] }));
  await new RunQaUseCase(r.deps({ review: rejectingOnce(["flows/a.spec.ts never asserts the total"]), config: SPENT })).run(INPUT);
  assert.deepEqual(kept.seen.corrected, []);
  assert.deepEqual(kept.seen.left.map((l) => [l.origin, l.reason]), [[CORRECTION_ORIGIN.REVIEW, "lead correction budget spent"]]);
  assert.equal(r.enrichments.filter((e) => e.reviewCorrections !== undefined).length, 0, "no author was sent the finding");
  const alone = rig();
  await new RunQaUseCase(alone.deps({ review: rejectingOnce(["flows/a.spec.ts never asserts the total"]), config: SPENT })).run(INPUT);
  assert.equal(alone.enrichments.filter((e) => e.reviewCorrections !== undefined).length, 1, "without a pass the author regenerates as before");
});

/* ── A mutant that survived a line a delivered test executed: the test reached the change and checked nothing ── */

const SIGNAL_BRANCH_CASES = { needsReview: false, shadow: false, onFailure: "github-issue" as const, maxRetries: 2, isCode: false, coveragePolicyMode: "signal" as const, coverageBranchCases: "regenerate" as const };
const survivor = (line: number, specFiles?: string[]) => ({ file: "src/list.ts", line, operator: "negate condition", original: "n > 0", replacement: "!(n > 0)", ...(specFiles ? { specFiles } : {}) });
const withSurvivors = (survived: ReturnType<typeof survivor>[], killed = 0) => ({
  measure: async () => ({ status: "pass" as const, ratio: 1, bundleMutation: { applied: survived.length + killed, killed, survived } }),
  blocks: () => false,
});
function coordinatedRig() {
  let kept!: ReturnType<typeof keptPass>;
  const r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: ["flows/a.spec.ts"], rebuttals: [], unrouted: [] }));
  return { r, kept };
}

test("a surviving mutant reaches the lead as a finding owned by the spec that reached it, in the one regeneration of the run, without any untaken arm", async () => {
  const { r, kept } = coordinatedRig();
  const result = await new RunQaUseCase(r.deps({ objectiveSignal: withSurvivors([survivor(4, ["flows/a.spec.ts"])]), config: SIGNAL_BRANCH_CASES })).run(INPUT);
  assert.deepEqual(kept.seen.origins, [CORRECTION_ORIGIN.COVERAGE], "one regeneration");
  const [finding] = kept.seen.corrected[0]!;
  assert.equal(finding!.spec, "flows/a.spec.ts");
  assert.ok(finding!.text.includes("src/list.ts:4") && finding!.text.includes("negate condition"));
  assert.equal(result.outcome?.verdict, "pass", "a survivor never changes the verdict");
});

test("a mutant reached by two specs is told to each, and one no spec reached is still told to the lead without an owner", async () => {
  const { r, kept } = coordinatedRig();
  await new RunQaUseCase(r.deps({ objectiveSignal: withSurvivors([survivor(4, ["flows/a.spec.ts", "flows/b.spec.ts"]), survivor(9)]), config: SIGNAL_BRANCH_CASES })).run(INPUT);
  assert.deepEqual(kept.seen.corrected[0]!.map((f) => f.spec), ["flows/a.spec.ts", "flows/b.spec.ts", undefined]);
});

test("survivors join the arms no test ran in the same regeneration instead of opening another", async () => {
  const { r, kept } = coordinatedRig();
  const objectiveSignal = {
    blocks: () => false,
    measure: async () => ({ status: "pass" as const, ratio: 1, untakenArms: [{ file: "src/list.ts", line: 7, kind: "if", arm: "the then" }], bundleMutation: { applied: 1, killed: 0, survived: [survivor(4, ["flows/a.spec.ts"])] } }),
  };
  await new RunQaUseCase(r.deps({ objectiveSignal, config: SIGNAL_BRANCH_CASES })).run(INPUT);
  assert.equal(kept.seen.corrected.length, 1);
  assert.equal(kept.seen.corrected[0]!.length, 2, "the arm and the survivor");
});

test("killed mutants, and a measurement with no mutants, produce no regeneration", async () => {
  for (const objectiveSignal of [withSurvivors([], 3), { measure: async () => ({ status: "pass" as const, ratio: 1 }), blocks: () => false }]) {
    const { r, kept } = coordinatedRig();
    await new RunQaUseCase(r.deps({ objectiveSignal, config: SIGNAL_BRANCH_CASES })).run(INPUT);
    assert.deepEqual(kept.seen.corrected, []);
    assert.equal(r.calls.filter((c) => c === "generate").length, 0);
  }
});

test("survivors with the branch cases off regenerate nothing", async () => {
  const { r, kept } = coordinatedRig();
  const { coverageBranchCases: _on, ...off } = SIGNAL_BRANCH_CASES;
  await new RunQaUseCase(r.deps({ objectiveSignal: withSurvivors([survivor(4, ["flows/a.spec.ts"])]), config: off })).run(INPUT);
  assert.deepEqual(kept.seen.corrected, []);
});

test("when the lead's correction budget is spent the survivors stay unrouted and no cold author regenerates them", async () => {
  const { r, kept } = coordinatedRig();
  await new RunQaUseCase(r.deps({ objectiveSignal: withSurvivors([survivor(4, ["flows/a.spec.ts"])]), config: { ...SIGNAL_BRANCH_CASES, maxRetries: SPENT.maxRetries } })).run(INPUT);
  assert.deepEqual(kept.seen.corrected, []);
  assert.deepEqual(kept.seen.left, [{ count: 1, origin: CORRECTION_ORIGIN.COVERAGE, reason: "lead correction budget spent" }]);
  assert.equal(r.calls.filter((c) => c === "generate").length, 0);
});

test("a run the lead authored alone is given the survivors in its gap text", async () => {
  const r = rig();
  await new RunQaUseCase(r.deps({ objectiveSignal: withSurvivors([survivor(4, ["flows/a.spec.ts"])]), config: SIGNAL_BRANCH_CASES })).run(INPUT);
  const gap = r.enrichments.find((e) => e.coverageGap !== undefined);
  assert.match(gap?.coverageGap ?? "", /src\/list\.ts:4/);
});

/* ── a run whose final execution is flaky: green after a retry ───────────────────────────────── */

/* A case that failed its first attempt and passed on retry. */
const flakyCase = (over: Partial<QaCase> = {}): QaCase => ({ name: "lists the restaurants", status: "flaky", file: "flows/a.spec.ts", detail: "expected 3 rows, received 0", ...over });

/* An execution that ends flaky with these cases, and passes the specs an acceptance executes afterwards. */
function flakyOnce(cases: QaCase[]) {
  const calls: Array<{ retries?: number }> = [];
  return {
    calls,
    execution: { execute: async (_dir: string, opts?: { retries?: number }) => {
      calls.push({ retries: opts?.retries });
      return calls.length === 1
        ? { verdict: "flaky" as const, cases, logs: "" }
        : { verdict: "pass" as const, cases: cases.map((c) => ({ name: c.name, status: "pass" as const, file: c.file! })), logs: "" };
    } },
  };
}

test("a flaky run is measured and reviewed like a pass, and is still quarantined", async () => {
  const r = rig();
  let measured = 0;
  let reviewed = 0;
  const flaky = flakyOnce([flakyCase()]);
  const result = await new RunQaUseCase(r.deps({
    execution: flaky.execution,
    objectiveSignal: { measure: async () => (measured++, { status: "unknown" as const, ratio: null }), blocks: () => false },
    review: { review: async () => (reviewed++, { approved: true, corrections: [], blockingCount: 0, parsed: true }) },
  })).run(INPUT);
  assert.equal(measured, 1, "the change-coverage of the green bytes is measured");
  assert.equal(reviewed, 1, "the reviewer judges the specs");
  assert.equal(result.decision.verdict, "flaky");
  assert.equal(result.decision.sideEffect, "quarantine");
});

test("a flaky run whose reviewer cannot be reached is still quarantined, not an infra-error", async () => {
  const r = rig();
  const flaky = flakyOnce([flakyCase()]);
  const result = await new RunQaUseCase(r.deps({
    execution: flaky.execution,
    review: { review: async () => ({ approved: false, corrections: [], blockingCount: 0, parsed: false, unavailable: true }) },
  })).run(INPUT);
  assert.equal(result.decision.verdict, "flaky");
  assert.equal(result.decision.sideEffect, "quarantine");
  assert.notEqual(result.outcome?.errorClass, "E-REVIEWER-UNAVAILABLE");
});

/* A Context Pack that read the restaurants page with three results. */
const PACK_READ_RESTAURANTS = { ground: async () => ({ packConfirmedDataRoutes: [{ path: "/restaurants", resultCount: 3 }] }) };

test("a flaky case whose first attempt read an empty data state reaches its flow as DEV data instability", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: ["flows/a.spec.ts"], rebuttals: [], unrouted: [] }));
  const flaky = flakyOnce([flakyCase({ failureResultCount: 0, finalUrl: "https://dev/restaurants", failureSettle: { inFlight: 0, treeStable: true } })]);
  const result = await new RunQaUseCase(r.deps({ execution: flaky.execution, preGenerationGrounding: PACK_READ_RESTAURANTS })).run(INPUT);
  assert.deepEqual(kept.seen.origins, [CORRECTION_ORIGIN.FLAKY]);
  assert.equal(kept.seen.corrected[0]?.length, 1);
  assert.equal(kept.seen.corrected[0]![0]!.spec, "flows/a.spec.ts", "the finding is owned by the spec's flow");
  assert.match(kept.seen.corrected[0]![0]!.text, /passed on retry/);
  assert.match(kept.seen.corrected[0]![0]!.text, /depends on live data/);
  assert.doesNotMatch(kept.seen.corrected[0]![0]!.text, /location/, "the remedy names no app concept");
  assert.deepEqual(result.outcome?.gateSignals.flakyTriage, { cases: 1, dataInstability: 1, timing: 0, outcome: "accepted", kept: 1, restored: 0 });
  assert.equal(r.calls.filter((c) => c === "generate").length, 0, "no cold author");
  assert.deepEqual(flaky.calls.slice(1).map((c) => c.retries), [0], "the corrected spec stands only if it executes green without a retry");
  assert.equal(result.decision.verdict, "flaky", "a spec that passed once after a flaky run does not make the run publishable");
  assert.equal(result.decision.sideEffect, "quarantine");
});

test("a flaky case that read an empty state on a page the pack has no results for is timing, not data instability", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: ["flows/a.spec.ts"], rebuttals: [], unrouted: [] }));
  const flaky = flakyOnce([flakyCase({ failureResultCount: 0, finalUrl: "https://dev/restaurants", failureSettle: { inFlight: 0, treeStable: true } })]);
  const result = await new RunQaUseCase(r.deps({ execution: flaky.execution })).run(INPUT);
  assert.doesNotMatch(kept.seen.corrected[0]![0]!.text, /live data/);
  assert.deepEqual(result.outcome?.gateSignals.flakyTriage, { cases: 1, dataInstability: 0, timing: 1, outcome: "accepted", kept: 1, restored: 0 });
});

test("the coverage a flaky run records is recounted from the corrected bytes the triage accepted, after the first measurement", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: ["flows/a.spec.ts"], rebuttals: [], unrouted: [] }));
  const flaky = flakyOnce([flakyCase()]);
  const order: string[] = [];
  const result = await new RunQaUseCase(r.deps({
    execution: flaky.execution,
    config: { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: false, coveragePolicyMode: "signal" },
    objectiveSignal: {
      measure: async () => (order.push("measure"), { status: "pass" as const, ratio: 0.5, uncovered: [], untakenArms: [] }),
      recount: async (_br, _dir, _diff, reruns) => (order.push(`recount:${reruns.map((x) => x.namespace).join(",")}`), { status: "pass" as const, ratio: 1, uncovered: [], untakenArms: [], measurement: { changedLines: 4, coveredChanged: 4, changedFiles: 1, mappedFiles: 1 } }),
      blocks: () => false,
    },
  })).run(INPUT);
  assert.deepEqual(order, ["measure", "recount:coord-run-acc0"], "the correction is measured after the first measurement, from its own dumps");
  assert.equal(result.outcome?.gateSignals.coverageRatio, 1, "the record describes the bytes under review");
});

test("a flaky case with no data state to blame is routed as timing", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: ["flows/a.spec.ts"], rebuttals: [], unrouted: [] }));
  const flaky = flakyOnce([flakyCase({ detail: "locator not found" })]);
  await new RunQaUseCase(r.deps({ execution: flaky.execution })).run(INPUT);
  assert.match(kept.seen.corrected[0]![0]!.text, /Wait on the state the page shows/);
  assert.doesNotMatch(kept.seen.corrected[0]![0]!.text, /live data/);
});

test("when the lead's correction budget is spent the flaky findings stay unrouted and no cold author is asked", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: [], rebuttals: [], unrouted: [] }));
  const flaky = flakyOnce([flakyCase()]);
  const result = await new RunQaUseCase(r.deps({ execution: flaky.execution, config: SPENT })).run(INPUT);
  assert.deepEqual(kept.seen.corrected, []);
  assert.deepEqual(kept.seen.left.map((l) => [l.origin, l.reason]), [[CORRECTION_ORIGIN.FLAKY, "lead correction budget spent"]]);
  assert.equal(r.calls.filter((c) => c === "generate").length, 0);
  assert.equal(result.decision.verdict, "flaky");
});

test("a pass run is not triaged for flakiness, and a failing run still goes through the fix loop", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: ["flows/a.spec.ts"], rebuttals: [], unrouted: [] }));
  const green = await new RunQaUseCase(r.deps()).run(INPUT);
  assert.equal(green.decision.verdict, "pass");
  assert.equal(kept.seen.corrected.length, 0, "nothing to correct on a pass");
  const failing = await new RunQaUseCase(r.deps({ execution: failingOnce([FAILED_A]) })).run({ ...INPUT, runId: "coord-run-fail" });
  assert.equal(failing.decision.verdict, "pass");
  assert.deepEqual(kept.seen.origins, [CORRECTION_ORIGIN.EXECUTION]);
  assert.match(kept.seen.corrected[0]![0]!.text, /failed/);
});

test("the reviewer of a planned run is handed the change by flow under review, and a run with no plan none", async () => {
  const diff = ["diff --git a/src/cart.ts b/src/cart.ts", "--- a/src/cart.ts", "+++ b/src/cart.ts", "@@ -3,1 +3,2 @@", " ctx", "+export const total = 1;", "@@ -40,1 +41,2 @@", " ctx", "+export const far = 2;", ""].join("\n");
  const candidates = [pageCandidate("/cart", undefined, { id: "uc-cart", seeds: [{ file: "src/cart.ts", symbol: "total", range: { start: 1, end: 6 } }] })];
  const changeScope = { resolve: async () => ({ repos: [], reach: [], hubs: [], disagreements: [], omitted: 0, degraded: [] }), candidates: async () => candidates };
  const changeAnalysis = { classify: async () => ({ action: "generate" as const, reason: "diff touches src/cart.ts", diff }) };
  const seen: Array<ReviewEnrichment | undefined> = [];
  const review = { review: async (_dir: string, _cases: readonly QaCase[], _diff?: string, enrichment?: ReviewEnrichment) => (seen.push(enrichment), { approved: true, corrections: [], blockingCount: 0, parsed: true }) };

  const planned = rig(() => ({ ...authored(), flowCandidates: [{ specFile: "flows/a.spec.ts", candidates: ["uc-cart"] }] }));
  await new RunQaUseCase(planned.deps({ changeScope, changeAnalysis, review })).run(INPUT);
  const view = seen[0]?.changeView;
  assert.ok(view, "the planned review has the change by flow");
  assert.deepEqual(view.flows.map((f) => ({ specFile: f.specFile, owned: f.owned.map((o) => o.hunk.newStart) })), [{ specFile: "flows/a.spec.ts", owned: [3] }]);
  assert.deepEqual(view.unassigned.map((u) => u.hunk.newStart), [41]);
  assert.deepEqual(view.files.map((f) => f.path), ["src/cart.ts"]);

  seen.length = 0;
  await new RunQaUseCase(rig().deps({ changeScope, changeAnalysis, review })).run(INPUT);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.changeView, undefined, "a run with no plan keeps the whole diff");
});
