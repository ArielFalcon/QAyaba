/* A run may grant its generator the run_spec tool: the loop is opened after the login and before the first generation, probes are swept after every generation, and when every delivered spec was seen passing in its current bytes the regenerations that would only repeat that work are retired. The explicit no-op, the silence classes and the single change-coverage regeneration are untouched in both branches. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Sha } from "@kernel/sha.ts";
import { ERROR_CLASS } from "@kernel/error-class.ts";
import { ok } from "@kernel/result.ts";
import { RUN_PURPOSE } from "@kernel/run-mode.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { RunQaUseCase, type RunQaInput, type RunQaUseCaseDeps } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import type { ClosedLoopHandle, ClosedLoopOpenInput } from "@contexts/agent-tools/application/index.ts";
import type { GenerationEnrichment } from "@contexts/generation/application/index.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace, type RunWorkspace } from "../../../support/run-workspace.ts";
import { fakeWorkspace } from "./run-flow/fake-workspace.ts";
import { confinedSpecFiles } from "../../../../src/shared-infrastructure/spec-files.adapter.ts";
import { served } from "../../../support/coordinator-over-author.ts";
import { primaryChangeSet } from "../../../support/change-set.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_STATIC_FIX_ROUNDS } from "@kernel/derive-cycle-backstop.ts";
import { memoryLogger } from "@kernel/ports/logger.port.ts";
import { installProcessLogger, resetProcessLoggerForTests } from "@kernel/ports/process-logger.ts";

const INPUT: RunQaInput = { app: "demo", changeSet: primaryChangeSet("demo", Sha.of("abc1234")), sha: Sha.of("abc1234"), source: "manual", mode: "diff", target: "e2e", runId: "loop-run" };
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
      ...served(generationOnDisk(generationOver ?? {
        author: async (_d, _s, _diff, enrichment) => {
          r.generations++;
          events.push("generate");
          r.enrichments.push(enrichment ?? {});
          return scriptedGeneration({ specs: ["flows/a.spec.ts"]});
        },
      })),
      review: { review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }) },
      validation: { validate: async () => (events.push("validate"), { ok: true, errors: [] }) },
      execution: { execute: async () => (events.push("execute"), { verdict: "pass", cases: PASS, logs: "" }) },
      objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
      publication: { publish: async () => ({ outcome: "pr" }) },
      learning: { fold: async () => {}, retrieve: async () => [] },
      workspace: fakeWorkspace(ws),
      specFiles: confinedSpecFiles,
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
  await new RunQaUseCase(context.deps({ ...served({ author: async () => scriptedGeneration({ specs: [".qa/context.json"], note: "map" }) }) })).run({ ...INPUT, mode: "context" });
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
  await assert.rejects(new RunQaUseCase(thrown.deps({ validation: { validate: async () => { throw new Error("boom"); } } })).run(INPUT), /boom/);
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
    ...served(generationOnDisk({ author: async () => scriptedGeneration({ specs: ["flows/a.spec.ts", ".qa-probe/try.spec.ts", "e2e/.qa-probe/other.spec.ts"]}) })),
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

test("a static gate that keeps failing spends every static-fix round and ends the run invalid, whether or not the loop is closed: run_spec proves a spec runs, not that it passes the gate", async () => {
  const failing = { validate: async () => ({ ok: false, errors: ["[lint] playwright/expect-expect"] }) };
  for (const closed of [false, true]) {
    const r = rig({ closed });
    const out = await new RunQaUseCase(r.deps({ validation: failing })).run(INPUT);
    assert.equal(r.generations, 1 + MAX_STATIC_FIX_ROUNDS, `the first pass and every static-fix round, closed=${closed}`);
    assert.equal(out.decision.verdict, "invalid", `closed=${closed}`);
    assert.equal(out.gateSignals.retries, MAX_STATIC_FIX_ROUNDS, `closed=${closed}`);
  }
});

test("a lint error on a spec run_spec saw pass is repaired, the run goes on to execute, and the run's log says why the proven spec was rewritten", async () => {
  const memory = memoryLogger();
  installProcessLogger(memory);
  try {
    let validations = 0;
    const r = rig({ closed: true });
    const out = await new RunQaUseCase(r.deps({
      validation: { validate: async () => (validations++ === 0 ? { ok: false, errors: ["[lint] playwright/expect-expect"] } : { ok: true, errors: [] }) },
    })).run(INPUT);
    assert.equal(r.generations, 2, "the first pass and one static-fix round");
    assert.equal(out.gateSignals.retries, 1);
    assert.equal(out.decision.verdict, "pass");
    assert.ok(
      memory.entries.some((e) => e.level === "info" && e.fields?.ship === true && /run_spec/.test(e.message) && /static/.test(e.message)),
      "the decision is a shipped line of the run's log",
    );
  } finally {
    resetProcessLoggerForTests();
  }
});

/* A loop that is closed only while each delivered spec holds the bytes its last run_spec call passed in, as the real one decides. */
function provenBytesLoop(r: Rig): void {
  const proven = new Map<string, string>();
  const bytesOf = (file: string): string | undefined => (r.ws.has(file) ? readFileSync(join(r.ws.specDir, file), "utf8") : undefined);
  r.handle.isClosed = async (specs) => (r.closedAsked.push([...specs]), specs.every((f) => proven.has(f) && proven.get(f) === bytesOf(f)));
  r.handle.sweepProbes = async () => {
    r.events.push("sweep");
    if (proven.size === 0) for (const f of ["flows/a.spec.ts"]) { const b = bytesOf(f); if (b !== undefined) proven.set(f, b); }
  };
}

test("a static-fix round that rewrites a proven spec leaves the loop open for its new bytes, so a failing execution then regenerates; one that leaves the bytes keeps the fix loop retired", async () => {
  for (const rewrites of [true, false]) {
    let validations = 0;
    const r = rig();
    provenBytesLoop(r);
    const out = await new RunQaUseCase(r.deps({
      generation: {
        author: async () => {
          r.generations++;
          r.events.push("generate");
          r.ws.write("flows/a.spec.ts", rewrites ? `// bytes ${r.generations}\n` : "// bytes 1\n");
          return scriptedGeneration({ specs: ["flows/a.spec.ts"] });
        },
      },
      validation: { validate: async () => (validations++ === 0 ? { ok: false, errors: ["[lint] playwright/expect-expect"] } : { ok: true, errors: [] }) },
      execution: { execute: async () => ({ verdict: "fail" as const, cases: FAIL, logs: "" }) },
    })).run(INPUT);
    assert.equal(out.gateSignals.retries >= 1, true, `the static gate was repaired, rewrites=${rewrites}`);
    if (rewrites) {
      assert.ok(r.generations > 2, "the fix loop regenerates the repaired bytes, which run_spec never saw pass");
      assert.equal(out.gateSignals.closedLoop?.closed, false);
    } else {
      assert.equal(r.generations, 2, "the first pass and the static-fix round; the fix loop is retired for bytes run_spec saw pass");
      assert.equal(out.gateSignals.closedLoop?.closed, true);
    }
  }
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
      ...served({ author: async () => scriptedGeneration({ specs: [], end: GENERATION_END.DECLARED_NOOP, note: "nothing worth testing" }) }),
    })).run(INPUT);
    assert.equal(out.decision.verdict, "skipped", `closed=${closed}`);
    assert.equal(r.events.filter((e) => e === "close").length, 1);
  }
});

test("silence is still not a decision, and running out of steps or time still end the run as their own errors", async () => {
  for (const closed of [true, false]) {
    for (const end of [GENERATION_END.UNDECIDED_EMPTY, GENERATION_END.EXHAUSTED, GENERATION_END.TIME_BUDGET]) {
      const r = rig({ closed });
      const out = await new RunQaUseCase(r.deps({ ...served({ author: async () => scriptedGeneration({ specs: [], end, note: "no verdict" }) }) })).run({ ...INPUT, runId: `silence-${end}` });
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
    assert.equal(r.enrichments[1]!.closedLoop, undefined, "an author of the run's own authoring is bound to no loop, so it is told no budget");
    assert.ok(r.events.lastIndexOf("close") > r.events.lastIndexOf("generate"), "the loop outlives the last generation");
  }
});


/* ── A gap regeneration stands only on an execution of the bytes it accepted, never on a run_spec proof ──────────────────────── */

const ARMS = [
  { file: "src/a.ts", line: 3, kind: "if", arm: "else" },
  { file: "src/a.ts", line: 7, kind: "logical", arm: "right of || evaluated" },
];
const SURVIVOR_SITE = {
  file: "src/a.ts",
  line: 9,
  column: 2,
  operator: "negate condition",
  script: { url: "https://dev.example/main.js", sha256: "h" },
  edit: { start: 3, end: 8, replacement: "!(ok)" },
  original: "ok",
  ranIn: ["flows-a-spec-ts-a-0.json"],
};
/* The regeneration renamed the test and added one: only an execution of its bytes knows their names. */
const CURRENT: QaCase[] = [{ name: "a when dark", status: "pass", file: "flows/a.spec.ts" }, { name: "a when light", status: "pass", file: "flows/a.spec.ts" }];

function gapRig(closed: boolean, measured: { verdict: "pass" | "fail"; cases: QaCase[] }) {
  const r = rig({ closed });
  const executions: { namespace?: string; specFiles?: string[] }[] = [];
  const rechecked: string[][] = [];
  const recounted: unknown[] = [];
  let turns = 0;
  const deps = r.deps({
    ...served({
      author: async (specDir) => {
        r.generations++;
        mkdirSync(join(specDir, "flows"), { recursive: true });
        writeFileSync(join(specDir, "flows/a.spec.ts"), `// pass ${++turns}\n`);
        return scriptedGeneration({ specs: ["flows/a.spec.ts"] });
      },
    }),
    execution: {
      execute: async (_dir, opts) => {
        const { namespace, specFiles } = (opts ?? {}) as { namespace?: string; specFiles?: string[] };
        executions.push({ ...(namespace ? { namespace } : {}), ...(specFiles ? { specFiles } : {}) });
        if (!namespace?.includes("-acc")) return { verdict: "pass", cases: PASS, logs: "" };
        return { verdict: measured.verdict, cases: measured.cases, logs: "" };
      },
    },
    objectiveSignal: {
      measure: async () => ({
        status: "pass",
        ratio: 0.9,
        uncovered: [],
        untakenArms: ARMS,
        bundleMutation: { applied: 1, killed: 0, survived: [{ file: "src/a.ts", line: 9, operator: "negate condition", specFiles: ["flows/a.spec.ts"] }] },
        survivorRuns: [{ site: SURVIVOR_SITE, specFiles: ["flows/a.spec.ts"] }],
        measurement: { changedLines: 10, coveredChanged: 9, changedFiles: 1, mappedFiles: 1, changedBranches: 6, takenBranches: 4 },
      }),
      blocks: () => false,
      recount: async (_br, _dir, _diff, reruns) => {
        recounted.push(reruns);
        return { status: "pass", ratio: 1, uncovered: [], untakenArms: [ARMS[1]!], measurement: { changedLines: 10, coveredChanged: 10, changedFiles: 1, mappedFiles: 1, changedBranches: 6, takenBranches: 5 } };
      },
      recheckSurvivors: async (_survivors, _dir, _namespace, baselineCases) => {
        rechecked.push([...baselineCases]);
        return { applied: 1, killed: 1, survived: [] };
      },
    },
    config: { needsReview: false, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: false, coveragePolicyMode: "signal", coverageBranchCases: "regenerate" },
  });
  return { r, deps, executions, rechecked, recounted };
}

test("a gap regeneration whose bytes hold a run_spec proof is still executed by its acceptance: the closure judges its current cases and the coverage is recounted from that execution", async () => {
  const { r, deps, executions, rechecked, recounted } = gapRig(true, { verdict: "pass", cases: CURRENT });

  const out = await new RunQaUseCase(deps).run(INPUT);

  assert.equal(r.generations, 2, "the first pass and the branch-case regeneration");
  assert.deepEqual(executions.filter((e) => e.namespace?.includes("-acc")), [{ namespace: "loop-run-acc0", specFiles: ["flows/a.spec.ts"] }], "one acceptance execution of the regenerated bytes, the proof notwithstanding");
  assert.deepEqual(rechecked, [["a when dark", "a when light"]], "the survivor is judged against the tests the accepted bytes hold");
  assert.deepEqual(recounted, [[{ namespace: "loop-run-acc0", specFiles: ["flows/a.spec.ts"] }]]);
  const signals = r.saved.at(-1)!.gateSignals;
  assert.deepEqual(signals.branchCases, { outcome: "accepted", armsBefore: 2, armsAfter: 1, kept: 1, restored: 0 });
  assert.deepEqual(signals.branchCoverage, { changed: 6, taken: 5 }, "the recount is what the run records");
  assert.deepEqual(signals.survivorClosure, { routed: 1, judged: 1, closed: 1, open: [] });
  assert.deepEqual(r.saved.at(-1)!.cases?.map((c) => c.name).sort(), ["a when dark", "a when light"]);
  assert.equal(out.decision.sideEffect, "pr");
});

test("a gap regeneration whose proved bytes fail their acceptance execution gets its prior bytes, cases and delivery back: no case of bytes that are gone is kept", async () => {
  const { r, deps, rechecked, recounted } = gapRig(true, { verdict: "fail", cases: [{ name: "a when dark", status: "fail", file: "flows/a.spec.ts", detail: "DEV slow" }] });

  const out = await new RunQaUseCase(deps).run(INPUT);

  assert.equal(readFileSync(join(r.ws.specDir, "flows/a.spec.ts"), "utf8"), "// pass 1\n", "the bytes that executed green are back");
  assert.deepEqual(recounted, [], "the first measurement stands");
  assert.deepEqual(rechecked, [], "nothing accepted, no survivor judged");
  const saved = r.saved.at(-1)!;
  assert.deepEqual(saved.gateSignals.branchCases, { outcome: "rejected", armsBefore: 2, armsAfter: 2, kept: 0, restored: 1 }, "the first measurement stands");
  assert.equal(saved.gateSignals.survivorClosure, undefined);
  assert.deepEqual(saved.cases, PASS, "the cases are those of the bytes on disk");
  assert.equal(out.decision.sideEffect, "pr", "the first proven suite stands");
});

test("a gap regeneration whose acceptance executed its specs is measured from that execution alone", async () => {
  const { deps, executions, rechecked, recounted } = gapRig(false, { verdict: "pass", cases: CURRENT });

  await new RunQaUseCase(deps).run(INPUT);

  assert.deepEqual(executions.filter((e) => e.namespace?.includes("-acc")), [{ namespace: "loop-run-acc0", specFiles: ["flows/a.spec.ts"] }]);
  assert.deepEqual(rechecked, [["a when dark", "a when light"]]);
  assert.deepEqual(recounted, [[{ namespace: "loop-run-acc0", specFiles: ["flows/a.spec.ts"] }]]);
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
