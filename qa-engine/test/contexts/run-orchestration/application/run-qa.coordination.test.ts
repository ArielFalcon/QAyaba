/* A run that generates asks its lead for a plan and the coordinator authors the flows; what it hands back is read like any generation. A run the coordinator hands back to the lead, or one with no coordinator wired, is authored by the lead alone. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
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
import type { GenerationEnrichment } from "@contexts/generation/application/index.ts";
import type { PlanOutput } from "@kernel/plan-output.ts";
import { leadCorrectionBudget } from "@contexts/run-orchestration/domain/lead-correction-budget.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace, type RunWorkspace } from "../../../support/run-workspace.ts";
import { fakeWorkspace } from "./run-flow/fake-workspace.ts";
import { confinedSpecFiles } from "../../../../src/shared-infrastructure/spec-files.adapter.ts";
const INPUT: RunQaInput = { app: "demo", sha: Sha.of("abc1234"), source: "manual", mode: "diff", target: "e2e", runId: "coord-run" };
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
      generate: async (_d, _s, _diff, enrichment) => {
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

test("a run with no coordinator wired generates in one lead turn, with no planning limits in the enrichment", async () => {
  const bare = rig();
  await new RunQaUseCase(bare.deps({ leadSidekicks: undefined })).run(INPUT);
  assert.equal(bare.coordinated.length, 0);
  assert.equal(bare.planned.length, 0);
  assert.deepEqual(bare.calls.filter((c) => c === "generate"), ["generate"]);
  assert.ok(bare.enrichments.every((e) => e.planning === undefined));
});

test("a run with no coordinator records no coordination, and a coordinated one records what became of it", async () => {
  const bare = rig();
  const plain = await new RunQaUseCase(bare.deps({ leadSidekicks: undefined })).run(INPUT);
  assert.equal(plain.outcome?.gateSignals.coordination, undefined);

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
  const planned = await input!.plan!({ maxFlows: 4, maxParallel: 2, budgetMs: 60_000 });
  assert.equal(planned.parsed, true);
  assert.deepEqual(r.planned[0]!.planning, { maxFlows: 4, maxParallel: 2, budgetMs: 60_000 });
  assert.equal(r.planned[0]!.runId, "coord-run");
  assert.ok(r.planned[0]!.closedLoop && r.planned[0]!.agentBrowser, "the plan turn is told the tool budgets like any generation");
});

test("the pages the grounding linked to the change reach the coordinator, and a run that linked none passes none", async () => {
  const grounded = rig();
  const preGenerationGrounding = { ground: async () => ({ changeRoutes: ["/order", "/upload-menu"] }) };
  await new RunQaUseCase(grounded.deps({ preGenerationGrounding })).run(INPUT);
  assert.deepEqual(grounded.coordinated[0]!.changeRoutes, ["/order", "/upload-menu"]);
  const plain = rig();
  await new RunQaUseCase(plain.deps({ preGenerationGrounding: { ground: async () => ({}) } })).run(INPUT);
  assert.equal(plain.coordinated[0]!.changeRoutes, undefined);
});

test("the proofs of the pages the call graph added reach the coordinator, and a run whose graph added none passes none", async () => {
  const proven = rig();
  const pages = [{ route: "/upload-menu", proof: ["src/menu.ts::upload", "page /upload-menu"] }];
  const preGenerationGrounding = { ground: async () => ({ changeRoutes: ["/order", "/upload-menu"], changePages: { pages, hubs: [], disagreements: [], omitted: 0 } }) };
  await new RunQaUseCase(proven.deps({ preGenerationGrounding })).run(INPUT);
  assert.deepEqual(proven.coordinated[0]!.changeProofs, pages);
  const plain = rig();
  await new RunQaUseCase(plain.deps({ preGenerationGrounding: { ground: async () => ({ changeRoutes: ["/order"] }) } })).run(INPUT);
  assert.equal(plain.coordinated[0]!.changeProofs, undefined);
});

test("a generation that cannot plan is told to the coordinator as no planning turn", async () => {
  const r = rig();
  await new RunQaUseCase(r.deps({ generation: { generate: async () => scriptedGeneration({ specs: ["flows/a.spec.ts"]}) } })).run(INPUT);
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
  await new RunQaUseCase(context.deps({ generation: { generate: async () => scriptedGeneration({ specs: [".qa/context.json"], note: "map" }) } })).run({ ...INPUT, mode: "context" });
  assert.equal(context.coordinated.length, 0, "context");

  const regression = rig();
  await new RunQaUseCase(regression.deps({ changeAnalysis: { classify: async () => ({ action: "regression", reason: "no source change", diff: "" }) } })).run(INPUT);
  assert.equal(regression.coordinated.length, 0, "regression");

  const unauthored = rig();
  await new RunQaUseCase(unauthored.deps({ authSession: { prepare: async () => ({ unauthored: true }) } })).run(INPUT);
  assert.equal(unauthored.coordinated.length, 0, "a login still to write");
});

test("without the coordinator wired, nothing is planned and the lead authors alone", async () => {
  const r = rig();
  await new RunQaUseCase(r.deps({ leadSidekicks: undefined })).run(INPUT);
  assert.equal(r.calls.filter((c) => c === "generate").length, 1);
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


/* A coordinated pass kept open: it records what it was asked to correct and how many times it was released, and corrects as told. */
function keptPass(r: Rig, answer: (findings: readonly CorrectionFinding[]) => PassCorrection) {
  const seen = { corrected: [] as CorrectionFinding[][], origins: [] as CorrectionOrigin[], released: 0 };
  const pass: CoordinatedPass = {
    correct: async (findings, origin = CORRECTION_ORIGIN.REVIEW) => {
      seen.corrected.push([...findings]);
      seen.origins.push(origin);
      const out = answer(findings);
      for (const spec of out.specs) r.ws.write(spec, `// corrected ${spec}\n`);
      return out;
    },
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

test("a finding no flow was sent goes to a regeneration with only that finding", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: [], rebuttals: [], unrouted: [0] }));
  await new RunQaUseCase(r.deps({ review: rejectingOnce(["a loose finding"]) })).run(INPUT);
  const regen = r.enrichments.filter((e) => e.reviewCorrections !== undefined);
  assert.deepEqual(kept.seen.corrected, [[{ text: "a loose finding" }]], "the lead is asked first");
  assert.deepEqual(regen.map((e) => e.reviewCorrections), [["a loose finding"]]);
  assert.equal(kept.seen.released, 1);
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

test("a failing case no flow takes goes to the lead's regeneration with only that case", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => flowsAB(kept.pass));
  kept = keptPass(r, (findings) => ({ readable: true, specs: ["flows/a.spec.ts"], rebuttals: [], unrouted: findings.flatMap((f, i) => (f.spec === "flows/b.spec.ts" ? [i] : [])) }));
  await new RunQaUseCase(r.deps({ execution: failingOnce([FAILED_A, FAILED_B]) })).run(INPUT);
  assert.equal(kept.seen.corrected[0]?.length, 2, "the lead is asked about both");
  const regen = r.enrichments.filter((e) => e.fixCases !== undefined);
  assert.deepEqual(regen.map((e) => e.fixCases!.map((c) => c.name)), [[FAILED_B.name]]);
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

test("what no flow takes is told apart by position, not by text: two failures that read the same regenerate only the one left", async () => {
  let r!: Rig;
  let kept!: ReturnType<typeof keptPass>;
  r = rig(() => delivered(kept.pass));
  kept = keptPass(r, () => ({ readable: true, specs: [], rebuttals: [], unrouted: [1] }));
  const twin: QaCase = { name: "loads", status: "fail", detail: "timeout" };
  await new RunQaUseCase(r.deps({ execution: failingOnce([{ ...twin, flow: "first" }, { ...twin, flow: "second" }]) })).run(INPUT);
  assert.equal(kept.seen.corrected[0]![0]!.text, kept.seen.corrected[0]![1]!.text, "the two findings read the same");
  const regen = r.enrichments.find((e) => e.fixCases !== undefined);
  assert.deepEqual(regen?.fixCases?.map((c) => c.flow), ["second"]);
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
