/* A run may grant its generator the run_spec tool: the loop is opened after the login and before the first generation, probes are swept after every generation, and when every delivered spec was seen passing in its current bytes the regenerations that would only repeat that work are retired. The explicit no-op, the silence classes and the single change-coverage regeneration are untouched in both branches. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import { RUN_PURPOSE } from "@kernel/run-mode.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { RunQaUseCase, type RunQaInput, type RunQaUseCaseDeps } from "@contexts/qa-run-orchestration/application/run-qa.use-case.ts";
import type { ClosedLoopHandle, ClosedLoopOpenInput, GenerationEnrichment } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace, type RunWorkspace } from "../../../support/run-workspace.ts";

const INPUT: RunQaInput = { app: "demo", sha: Sha.of("abc1234"), source: "manual", mode: "diff", target: "e2e", runId: "loop-run" };
const LIMITS = { maxCalls: 8, perCallMs: 120_000, maxDevWrites: 20 };
const PASS: QaCase[] = [{ name: "a", status: "pass", file: "flows/a.spec.ts" }];
const FAIL: QaCase[] = [{ name: "a", status: "fail", file: "flows/a.spec.ts", detail: "expected 1 got 2" }];
const FABRICATED = `await page.goto("/owners"); await page.getByTestId("ghost-id").click();`;
const GHOST_ROUTES = [{ route: "/owners", nodes: [], status: "captured" as const, settled: true, testIds: new Map<string, number>() }];

interface Rig {
  events: string[];
  opened: ClosedLoopOpenInput[];
  enrichments: GenerationEnrichment[];
  saved: RunOutcome[];
  generations: number;
  closedAsked: string[][];
  handle: ClosedLoopHandle;
  closedState: { value: boolean };
  ws: RunWorkspace;
  deps(over?: Partial<RunQaUseCaseDeps>): RunQaUseCaseDeps;
}

function rig(opts: { closed?: boolean; openThrows?: boolean; grant?: boolean } = {}): Rig {
  const ws = runWorkspace("qa-loop-");
  const events: string[] = [];
  const closedState = { value: opts.closed ?? false };
  const closedAsked: string[][] = [];
  const handle: ClosedLoopHandle = {
    limits: LIMITS,
    openFlow: () => undefined,
    sweepProbes: async () => void events.push("sweep"),
    isClosed: async (specs) => (closedAsked.push([...specs]), closedState.value),
    signals: () => ({ calls: 3, devWrites: 2 }),
    close: async () => void events.push("close"),
  };
  const r: Rig = { events, opened: [], enrichments: [], saved: [], generations: 0, closedAsked, handle, closedState, ws, deps: undefined as never };
  r.deps = (over = {}) => {
    const { generation: generationOver, ...rest } = over;
    return {
      changeAnalysis: { classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "" }) },
      generation: generationOnDisk(generationOver ?? {
        generate: async (_d, _s, _diff, enrichment) => {
          r.generations++;
          events.push("generate");
          r.enrichments.push(enrichment ?? {});
          return scriptedGeneration({ specs: ["flows/a.spec.ts"], approved: true });
        },
      }),
      review: { review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }) },
      validation: { validate: async () => (events.push("validate"), { ok: true, errors: [] }) },
      execution: { execute: async () => (events.push("execute"), { verdict: "pass", cases: PASS, logs: "" }) },
      objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
      publication: { publish: async () => ({ outcome: "pr" }) },
      learning: { fold: async () => {}, retrieve: async () => [] },
      workspace: { prepare: async () => ({ specDir: ws.specDir, mirrorDir: ws.mirrorDir }) },
      suiteStore: ws.suiteStore,
      deployGate: { waitUntilServing: async () => ok(true) },
      runHistory: { save: async (outcome) => void r.saved.push(outcome) },
      confinement: { enforce: async () => (events.push("confine"), { strays: 0, dangerous: 0, reverted: [] }) },
      closedLoop: {
        open: async (input) => {
          r.opened.push(input);
          events.push("open");
          if (opts.openThrows) throw new Error("registry down");
          return opts.grant === false ? undefined : handle;
        },
      },
      config: { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: false },
      ...rest,
    };
  };
  return r;
}

test("without the port, or when it grants nothing, the run is what it always was", async () => {
  const none = rig();
  await new RunQaUseCase(none.deps({ closedLoop: undefined })).run(INPUT);
  assert.equal(none.enrichments[0]!.closedLoop, undefined);

  const refused = rig({ grant: false });
  const out = await new RunQaUseCase(refused.deps()).run(INPUT);
  assert.equal(refused.enrichments[0]!.closedLoop, undefined);
  assert.equal(out.gateSignals.closedLoop, undefined);
  assert.equal(refused.events.includes("close"), false);
});

test("the loop is opened for the run after its setup and before the first generation, and the generator is told its limits", async () => {
  const r = rig();
  await new RunQaUseCase(r.deps()).run(INPUT);
  assert.deepEqual(r.opened, [{ runId: "loop-run", app: "demo", mode: "diff", specDir: r.ws.specDir, mirrorDir: r.ws.mirrorDir }]);
  assert.ok(r.events.indexOf("open") < r.events.indexOf("generate"));
  assert.deepEqual(r.enrichments[0]!.closedLoop, LIMITS);
});

test("a per-run choice reaches the port", async () => {
  const r = rig();
  await new RunQaUseCase(r.deps()).run({ ...INPUT, closedLoop: false });
  assert.equal(r.opened[0]!.enabled, false);
});

test("no loop for a code run, a context run, a regression run, a login bootstrap, or a login the generator still has to write", async () => {
  const code = rig();
  await new RunQaUseCase(code.deps({ config: { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: true } })).run({ ...INPUT, target: "code" });
  assert.equal(code.opened.length, 0, "code");

  const context = rig();
  await new RunQaUseCase(context.deps({ generation: { generate: async () => scriptedGeneration({ specs: [".qa/context.json"], approved: true, note: "map" }) } })).run({ ...INPUT, mode: "context" });
  assert.equal(context.opened.length, 0, "context");

  const regression = rig();
  await new RunQaUseCase(regression.deps({ changeAnalysis: { classify: async () => ({ action: "regression", reason: "no source change", diff: "" }) } })).run(INPUT);
  assert.equal(regression.opened.length, 0, "regression");

  const bootstrap = rig();
  await new RunQaUseCase(bootstrap.deps()).run({ ...INPUT, mode: "manual", purpose: RUN_PURPOSE.LOGIN_BOOTSTRAP });
  assert.equal(bootstrap.opened.length, 0, "login bootstrap");

  const unauthored = rig();
  await new RunQaUseCase(unauthored.deps({
    authSession: { prepare: async () => ({ unauthored: true }) },
    authContext: { baseUrl: "https://dev", auth: { kind: "form", usernameEnv: "U", passwordEnv: "P" } },
  })).run(INPUT);
  assert.equal(unauthored.opened.length, 0, "no session yet");
});

test("a port that fails to open costs the run nothing but the loop", async () => {
  const r = rig({ openThrows: true });
  const out = await new RunQaUseCase(r.deps()).run(INPUT);
  assert.equal(out.decision.verdict, "pass");
  assert.equal(r.enrichments[0]!.closedLoop, undefined);
});

test("probes are swept after every generation, before the confinement pass and the static gate see the working copy", async () => {
  const r = rig();
  await new RunQaUseCase(r.deps()).run(INPUT);
  const generate = r.events.indexOf("generate");
  assert.equal(r.events[generate + 1], "sweep");
  assert.ok(r.events.indexOf("sweep") < r.events.indexOf("confine"));
  assert.ok(r.events.indexOf("sweep") < r.events.indexOf("validate"));
});

test("the loop is closed however the run ends: a result, an invalid run, a throw", async () => {
  const ok = rig();
  await new RunQaUseCase(ok.deps()).run(INPUT);
  assert.equal(ok.events.filter((e) => e === "close").length, 1);

  const invalid = rig();
  const out = await new RunQaUseCase(invalid.deps({ validation: { validate: async () => ({ ok: false, errors: ["[lint] x"] }) } })).run(INPUT);
  assert.equal(out.decision.verdict, "invalid");
  assert.equal(invalid.events.filter((e) => e === "close").length, 1);

  const thrown = rig();
  await assert.rejects(new RunQaUseCase(thrown.deps({ generation: { generate: async () => { throw new Error("boom"); } } })).run(INPUT), /boom/);
  assert.equal(thrown.events.filter((e) => e === "close").length, 1);
});

test("a handle that fails to close changes nothing about the result", async () => {
  const r = rig();
  r.handle.close = async () => { throw new Error("close failed"); };
  const out = await new RunQaUseCase(r.deps()).run(INPUT);
  assert.equal(out.decision.verdict, "pass");
});

test("a probe the generator listed as a deliverable is not delivered", async () => {
  const r = rig({ closed: true });
  const out = await new RunQaUseCase(r.deps({
    generation: { generate: async () => scriptedGeneration({ specs: ["flows/a.spec.ts", ".qa-probe/try.spec.ts", "e2e/.qa-probe/other.spec.ts"], approved: true }) },
  })).run(INPUT);
  assert.equal(out.decision.verdict, "pass");
  assert.deepEqual(r.closedAsked.at(-1), ["flows/a.spec.ts"]);
});

test("the signals the run reports are the loop's counts and whether it was closed", async () => {
  const closed = rig({ closed: true });
  const out = await new RunQaUseCase(closed.deps()).run(INPUT);
  assert.deepEqual(out.gateSignals.closedLoop, { calls: 3, devWrites: 2, closed: true });
  assert.deepEqual(closed.saved.at(-1)!.gateSignals.closedLoop, { calls: 3, devWrites: 2, closed: true });
  assert.deepEqual(closed.closedAsked.at(-1), ["flows/a.spec.ts"], "closed is asked about the delivered specs only");

  const open = rig({ closed: false });
  const out2 = await new RunQaUseCase(open.deps()).run(INPUT);
  assert.equal(out2.gateSignals.closedLoop?.closed, false);
});

test("a static-gate failure ends the run invalid and carries the signals", async () => {
  const r = rig({ closed: false });
  const out = await new RunQaUseCase(r.deps({ validation: { validate: async () => ({ ok: false, errors: ["[tsc] bad"] }) } })).run(INPUT);
  assert.equal(out.decision.verdict, "invalid");
  assert.equal(r.saved.at(-1)!.gateSignals.closedLoop?.calls, 3);
});

/* ── retired regenerations ────────────────────────────────────────────────────────────────────── */

test("static-fix rounds repair a failing gate when the loop is not closed, and do not when it is", async () => {
  const failing = { validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }) };
  const open = rig({ closed: false });
  await new RunQaUseCase(open.deps({ validation: failing })).run(INPUT);
  assert.equal(open.generations, 3, "the first pass and the two static-fix rounds");

  const closed = rig({ closed: true });
  const out = await new RunQaUseCase(closed.deps({ validation: failing })).run(INPUT);
  assert.equal(closed.generations, 1, "a spec the generator saw pass is not rewritten for a lint finding");
  assert.equal(out.decision.verdict, "invalid");
  assert.equal(out.gateSignals.retries, 0);
});

test("the pre-execution corrective regeneration is skipped when the loop is closed", async () => {
  const capture = async () => ({ specFiles: ["flows/a.spec.ts"], specSources: [FABRICATED], routes: GHOST_ROUTES });
  const open = rig({ closed: false });
  await new RunQaUseCase(open.deps({ preExecGrounding: { capture } })).run(INPUT);
  assert.equal(open.generations, 2);

  const closed = rig({ closed: true });
  await new RunQaUseCase(closed.deps({ preExecGrounding: { capture } })).run(INPUT);
  assert.equal(closed.generations, 1);
});

test("a failing execution regenerates when the loop is not closed, and goes to adjudication alone when it is", async () => {
  const failing = { execute: async () => (events.push("execute"), { verdict: "fail" as const, cases: FAIL, logs: "" }) };
  const events: string[] = [];

  const open = rig({ closed: false });
  await new RunQaUseCase(open.deps({ execution: failing })).run(INPUT);
  assert.ok(open.generations > 1, "the fix loop regenerates");

  const closed = rig({ closed: true });
  const out = await new RunQaUseCase(closed.deps({ execution: failing })).run(INPUT);
  assert.equal(closed.generations, 1, "no regeneration");
  assert.equal(out.decision.verdict, "fail");
  assert.equal(out.decision.sideEffect, "issue");
  assert.ok(closed.saved.at(-1)!.adjudication?.class, "the Issue still carries the adjudicator's class");
});

test("a deterministic infrastructure failure is still reclassified when the loop is closed", async () => {
  const infra: QaCase[] = [{ name: "a", status: "fail", file: "flows/a.spec.ts", detail: "net::ERR_CONNECTION_REFUSED at https://dev" }];
  const closed = rig({ closed: true });
  const out = await new RunQaUseCase(closed.deps({ execution: { execute: async () => ({ verdict: "fail", cases: infra, logs: "" }) } })).run(INPUT);
  assert.equal(closed.generations, 1);
  assert.notEqual(out.decision.sideEffect, "pr");
});

test("a closed loop never turns a declared no-op into anything but a skip", async () => {
  for (const closed of [true, false]) {
    const r = rig({ closed });
    const out = await new RunQaUseCase(r.deps({
      generation: { generate: async () => scriptedGeneration({ specs: [], approved: true, end: GENERATION_END.DECLARED_NOOP, note: "nothing worth testing" }) },
    })).run(INPUT);
    assert.equal(out.decision.verdict, "skipped", `closed=${closed}`);
    assert.equal(r.events.filter((e) => e === "close").length, 1);
  }
});

test("silence is still not a decision, and running out of steps or time still end the run as their own errors", async () => {
  for (const closed of [true, false]) {
    for (const end of [GENERATION_END.UNDECIDED_EMPTY, GENERATION_END.EXHAUSTED, GENERATION_END.TIME_BUDGET]) {
      const r = rig({ closed });
      const out = await new RunQaUseCase(r.deps({ generation: { generate: async () => scriptedGeneration({ specs: [], approved: false, end, note: "no verdict" }) } })).run({ ...INPUT, runId: `silence-${end}` });
      assert.equal(out.decision.verdict, "infra-error", `${end} closed=${closed}`);
    }
  }
});

test("the single change-coverage regeneration still runs when the loop is closed, once, with the loop still open for it", async () => {
  for (const closed of [true, false]) {
    let measures = 0;
    const r = rig({ closed });
    const out = await new RunQaUseCase(r.deps({
      objectiveSignal: {
        measure: async () => (measures++ === 0 ? { status: "fail", ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1, 2] }] } : { status: "pass", ratio: 0.9 }),
        blocks: (status) => status === "fail",
      },
      config: { needsReview: false, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: false, coveragePolicyMode: "enforce" },
    })).run(INPUT);
    assert.equal(out.decision.sideEffect, "pr", `closed=${closed}`);
    assert.equal(r.generations, 2, `the first pass and the one coverage regeneration, closed=${closed}`);
    assert.deepEqual(r.enrichments[1]!.closedLoop, LIMITS, "the regeneration may use the tool too");
    assert.ok(r.events.lastIndexOf("close") > r.events.lastIndexOf("generate"), "the loop outlives the last generation");
  }
});


test("a sweep that fails ends the run as an infra-error before anything validates, executes or publishes: probes the sweep left must not be judged or delivered", async () => {
  const r = rig();
  r.handle.sweepProbes = async () => { throw new Error("the probe tree could not be removed"); };
  let published = 0;
  const out = await new RunQaUseCase(r.deps({ publication: { publish: async () => (published++, { outcome: "pr" }) } })).run(INPUT);
  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(r.events.includes("validate"), false);
  assert.equal(r.events.includes("execute"), false);
  assert.equal(published, 0);
  assert.equal(r.saved.length, 1, "the run is recorded");
  assert.ok(r.events.includes("close"), "the loop is still closed");
});
