/* The specs a run delivers are carried into every regeneration it makes: merged after each generation pass (the lead's declarations refresh) and handed to each regeneration as `deliveredSpecs`; a selector contradiction is attributed to the specs that hold its selector as `attributedSpecFiles`. Driven through RunQaUseCase with the ports faked at the boundary. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
import { RunQaUseCase, type RunQaConfig } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import type {
  ExecutionPort,
  GenerationEnrichment,
  GenerationOutput,
  ObjectiveSignalPort,
  PreExecGroundingPort,
  ReviewPort,
  ValidationPort,
} from "@contexts/run-orchestration/application/ports/index.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace } from "../../../support/run-workspace.ts";

/** A spec the lead delivered and declared. */
const declared = (file: string, objective: string): DeliveredSpec => ({ file, flow: `${file} flow`, objective });

/** A generation result as the lead's adapter reports one: the specs it delivered and what the verdict declared for them. */
function lead(...specs: DeliveredSpec[]): GenerationOutput {
  return scriptedGeneration({ specs: specs.map((spec) => spec.file), declaredSpecs: specs, approved: true });
}

const A1 = declared("a.spec.ts", "O1");
const A2 = declared("a.spec.ts", "O2");
const B1 = declared("b.spec.ts", "OB");
const C1 = declared("c.spec.ts", "OC");

interface Scenario {
  /** What each generate() call returns, in order; the last one repeats. */
  generations: GenerationOutput[];
  validate?: ValidationPort["validate"];
  execute?: ExecutionPort["execute"];
  review?: ReviewPort["review"];
  measure?: ObjectiveSignalPort["measure"];
  blocks?: ObjectiveSignalPort["blocks"];
  capture?: PreExecGroundingPort["capture"];
  config?: Partial<RunQaConfig>;
  /** Files that are on disk under the suite directory when the run starts: what the run's spec directory holds before it starts. */
  files?: string[];
  /**
   * Rewrites the specs a regeneration delivers. The fixture generator only creates missing files, while a
   * real regeneration changes the bytes it delivers; acceptance sees those bytes change.
   */
  rewrite?: (call: number, specs: readonly string[], write: (file: string, text: string) => void) => void;
}

const PASSING: ExecutionPort["execute"] = async () => ({ verdict: "pass", cases: [], logs: "" });
const FAILS_THEN_PASSES = (): ExecutionPort["execute"] => {
  let executions = 0;
  return async () => (++executions === 1 ? { verdict: "fail", cases: [{ name: "checkout", status: "fail", detail: "boom" }], logs: "" } : { verdict: "pass", cases: [], logs: "" });
};
const FAILS_EVERY_TIME = (): ExecutionPort["execute"] => {
  let executions = 0;
  /* A new failing name each round keeps the loop's progress gate open for another regeneration. */
  return async (_specDir, opts) => {
    const o = opts && !(opts instanceof AbortSignal) ? opts : undefined;
    /* A live report names the spec each case came from; the fixture's first execution fails the first delivered spec. */
    return { verdict: "fail", cases: [{ name: `checkout-${++executions}`, status: "fail", file: o?.specFiles?.[0] ?? "a.spec.ts", detail: "boom" }], logs: "" };
  };
};
const INVALID_ONCE = (): ValidationPort["validate"] => {
  let validations = 0;
  return async () => (++validations === 1 ? { ok: false, infra: false, errors: ["TS2322: type mismatch"] } : { ok: true, errors: [] });
};
const REJECTS_ONCE = (): ReviewPort["review"] => {
  let reviews = 0;
  return async () => (++reviews === 1 ? { approved: false, corrections: ["[false-positive] the assertion targets the wrong element"], blockingCount: 1, parsed: true } : { approved: true, corrections: [], blockingCount: 0, parsed: true });
};
const COVERAGE_GAP: ObjectiveSignalPort["measure"] = async () => ({ status: "fail", ratio: 0.2, uncovered: [{ file: "src/a.ts", lines: [1, 2] }] });

/** The test-id the pre-exec catalog gate catches in `source`, which a spec at `a.spec.ts` holds: the page has `real-id` only. (A role ambiguity is advisory and requests no regeneration, so it is no trigger here.) */
const AMBIGUOUS = `await page.goto("/owners"); await page.getByTestId("ghost-id").click();`;
const CLEAN = `await page.goto("/owners"); await page.getByTestId("real-id").click();`;
const OWNERS_TWICE = [{ route: "/owners", nodes: [], status: "captured" as const, settled: true, testIds: new Map([["real-id", 1]]) }];
const OWNERS_ONCE = OWNERS_TWICE;

/** Runs the whole use case over a scratch mirror and returns the enrichment of every generate() call, in order. */
async function run(scenario: Scenario): Promise<GenerationEnrichment[]> {
  const ws = runWorkspace("qa-carry-forward-");
  try {
    for (const file of scenario.files ?? []) ws.write(file);
    const calls: GenerationEnrichment[] = [];
    const useCase = new RunQaUseCase({
      changeAnalysis: {
        classify: async () => ({
          action: "generate",
          reason: "diff touches many files",
          diff: "x",
          intent: { type: "feat", breaking: false, message: "cover checkout", changedFiles: Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`) },
          contradiction: true,
        }),
      },
      generation: generationOnDisk({
        generate: async (_specDir, _signal, _diff, enrichment) => {
          calls.push(enrichment ?? {});
          const output = scenario.generations[Math.min(calls.length - 1, scenario.generations.length - 1)]!;
          if (calls.length > 1) scenario.rewrite?.(calls.length, output.specs, (file, text) => ws.write(file, text));
          return output;
        },
      }),
      review: { review: scenario.review ?? (async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true })) },
      validation: { validate: scenario.validate ?? (async () => ({ ok: true, errors: [] })) },
      execution: { execute: scenario.execute ?? PASSING },
      objectiveSignal: { measure: scenario.measure ?? (async () => ({ status: "unknown", ratio: null })), blocks: scenario.blocks ?? (() => false) },
      publication: { publish: async () => ({ outcome: "pr" }) },
      learning: { fold: async () => {}, retrieve: async () => [] },
      workspace: { prepare: async () => ({ specDir: ws.specDir, mirrorDir: ws.mirrorDir }) },
      suiteStore: ws.suiteStore,
      deployGate: { waitUntilServing: async () => ok(true) },
      runHistory: { save: async () => {} },
      setup: { setup: async () => {} },
      cleanup: { cleanup: async () => {} },
      ...(scenario.capture ? { preExecGrounding: { capture: scenario.capture } } : {}),
      config: { needsReview: false, ...scenario.config },
    });
    await useCase.run({ app: "demo", sha: Sha.of("abc1234"), source: "manual", mode: "diff", target: "e2e", runId: "carry-forward" });
    return calls;
  } finally {
    ws.cleanup();
  }
}

/* ── what each regeneration is handed ── */

test("the first pass is handed no delivered specs and no attributed files: nothing was delivered yet", async () => {
  const calls = await run({ generations: [lead(A1)], validate: INVALID_ONCE() });
  assert.equal(calls.length, 2);
  assert.equal("deliveredSpecs" in calls[0]!, false);
  assert.equal("attributedSpecFiles" in calls[0]!, false);
});

test("a static-fix regeneration is handed the spec the first pass delivered, with what the lead declared for it", async () => {
  const calls = await run({ generations: [lead(A1)], validate: INVALID_ONCE() });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.fixCases?.[0]?.name, "static-gate");
  assert.deepEqual(calls[1]!.deliveredSpecs, [A1]);
});

test("a pre-exec corrective regeneration is handed the delivered specs, and the files its contradictions are attributed to", async () => {
  const calls = await run({
    generations: [lead(A1)],
    capture: async () => ({ specFiles: ["a.spec.ts"], specSources: [AMBIGUOUS], routes: OWNERS_TWICE }),
  });
  const corrective = calls[1]!;
  assert.ok((corrective.selectorContradictions?.length ?? 0) > 0, "the corrective regeneration carries the contradiction the gate caught");
  assert.deepEqual(corrective.deliveredSpecs, [A1]);
  assert.deepEqual(corrective.attributedSpecFiles, ["a.spec.ts"]);
});

test("a pre-exec contradiction the capture's own files do not hold is attributed to no file: the key is absent, not empty", async () => {
  const calls = await run({
    generations: [lead(A1)],
    capture: async () => ({ specFiles: [], specSources: [AMBIGUOUS], routes: OWNERS_TWICE }),
  });
  assert.ok((calls[1]!.selectorContradictions?.length ?? 0) > 0, "the corrective regeneration carries the contradiction the gate caught");
  assert.deepEqual(calls[1]!.deliveredSpecs, [A1]);
  assert.equal("attributedSpecFiles" in calls[1]!, false);
});

test("a pre-exec contradiction is attributed to the spec file that raised it, not to the others in the suite", async () => {
  const calls = await run({
    generations: [lead(A1)],
    capture: async () => ({
      specFiles: ["other.spec.ts", "a.spec.ts"],
      specSources: [`await page.getByRole("link", { name: "Home" }).click();`, AMBIGUOUS],
      routes: OWNERS_TWICE,
    }),
  });
  assert.deepEqual(calls[1]!.attributedSpecFiles, ["a.spec.ts"]);
});

test("a spec that holds a test-id the page has raised nothing and is not attributed", async () => {
  const calls = await run({
    generations: [lead(A1, B1)],
    capture: async () => ({ specFiles: ["a.spec.ts", "b.spec.ts"], specSources: [AMBIGUOUS, CLEAN], routes: OWNERS_TWICE }),
  });
  assert.ok((calls[1]!.selectorContradictions?.length ?? 0) > 0, "the corrective regeneration carries the contradiction the gate caught");
  assert.deepEqual(calls[1]!.attributedSpecFiles, ["a.spec.ts"]);
});

test("a FixLoop regeneration is handed the delivered specs", async () => {
  const calls = await run({ generations: [lead(A1)], execute: FAILS_THEN_PASSES() });
  assert.equal(calls.length, 2);
  assert.ok((calls[1]!.fixCases?.length ?? 0) > 0);
  assert.deepEqual(calls[1]!.deliveredSpecs, [A1]);
});

test("a FixLoop regeneration is handed the files its Lever-2 contradictions are attributed to: the specs of the latest generation that raised them", async () => {
  const absentButton = `await page.getByRole("button", { name: "Submit" }).click();`;
  const calls = await run({
    generations: [scriptedGeneration({ specs: ["a.spec.ts", "b.spec.ts"], declaredSpecs: [A1, B1], approved: true, specSources: [absentButton, `await page.getByRole("link", { name: "Home" }).click();`] })],
    execute: async () => ({ verdict: "fail", cases: [{ name: "checkout", status: "fail", detail: "boom", failureDom: "heading: Owners\nbutton: Cancel\nlink: Home" }], logs: "" }),
  });
  const regeneration = calls.find((call) => (call.selectorContradictions?.length ?? 0) > 0);
  assert.ok(regeneration, "the FixLoop regenerates with the contradiction Lever-2 found");
  assert.deepEqual(regeneration.attributedSpecFiles, ["a.spec.ts"]);
});

test("a later FixLoop round attributes its contradictions to the files of the generation before it, not the first pass's", async () => {
  const absentButton = `await page.getByRole("button", { name: "Submit" }).click();`;
  const clean = `await page.getByRole("heading", { name: "Owners" }).click();`;
  const calls = await run({
    generations: [
      scriptedGeneration({ specs: ["a.spec.ts"], declaredSpecs: [A1], approved: true, specSources: [clean] }),
      /* The round changes the spec that failed and adds the one whose selector is absent: the first failure is
         replaced by the round's own execution, so the loop has progress for one more round. */
      scriptedGeneration({ specs: ["a.spec.ts", "b.spec.ts"], declaredSpecs: [A1, B1], approved: true, specSources: [clean, absentButton] }),
    ],
    execute: (() => {
      let executions = 0;
      return async (_specDir, opts) => {
        const o = opts && !(opts instanceof AbortSignal) ? opts : undefined;
        return {
          verdict: "fail" as const,
          cases: [{ name: `checkout-${++executions}`, status: "fail" as const, file: o?.specFiles?.[0] ?? "a.spec.ts", detail: "boom", failureDom: "heading: Owners\nbutton: Cancel" }],
          logs: "",
        };
      };
    })(),
    rewrite: (call, specs, write) => {
      if (call > 1) for (const file of specs) write(file, `// round ${call} ${file}\n`);
    },
    config: { maxRetries: 2 },
  });
  const regeneration = calls.find((call) => (call.selectorContradictions?.length ?? 0) > 0);
  assert.ok(regeneration, "a FixLoop round regenerates with the contradiction the second generation's spec raises");
  assert.deepEqual(regeneration.attributedSpecFiles, ["b.spec.ts"]);
});

test("a pre-exec contradiction still pending reaches the first FixLoop regeneration with its attribution, and only that one", async () => {
  let captures = 0;
  const calls = await run({
    generations: [lead(A1)],
    /* The first capture sees the ambiguity, the corrective regeneration "fixes" it, and every later capture is clean. */
    capture: async () => ({ specFiles: ["a.spec.ts"], specSources: [++captures === 1 ? AMBIGUOUS : CLEAN], routes: captures === 1 ? OWNERS_TWICE : OWNERS_ONCE }),
    execute: FAILS_EVERY_TIME(),
    rewrite: (call, specs, write) => {
      if (call > 1) for (const file of specs) write(file, `// round ${call} ${file}\n`);
    },
    config: { maxRetries: 2 },
  });
  const fixLoopRegenerations = calls.filter((call) => (call.fixCases?.length ?? 0) > 0);
  assert.ok(fixLoopRegenerations.length >= 2, "the FixLoop regenerated twice");
  assert.ok((fixLoopRegenerations[0]!.selectorContradictions?.length ?? 0) > 0, "the pending pre-exec contradiction reaches the first FixLoop regeneration");
  assert.deepEqual(fixLoopRegenerations[0]!.attributedSpecFiles, ["a.spec.ts"]);
  assert.equal("attributedSpecFiles" in fixLoopRegenerations[1]!, false);
});

test("a coverage regeneration is handed the delivered specs", async () => {
  const calls = await run({ generations: [lead(A1), lead(C1)], measure: COVERAGE_GAP, blocks: (status) => status === "fail" });
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.coverageGap);
  assert.deepEqual(calls[1]!.deliveredSpecs, [A1]);
});

test("a reviewer-correction regeneration is handed the delivered specs", async () => {
  const calls = await run({ generations: [lead(A1)], review: REJECTS_ONCE(), config: { needsReview: true } });
  assert.equal(calls.length, 2);
  assert.ok((calls[1]!.reviewCorrections?.length ?? 0) > 0);
  assert.deepEqual(calls[1]!.deliveredSpecs, [A1]);
});

/* ── what each pass adds ── */

test("a later lead pass that delivers a spec again refreshes its objective: the next regeneration is handed the newest", async () => {
  const calls = await run({ generations: [lead(A1), lead(A2), lead(A2)], validate: INVALID_ONCE(), execute: FAILS_THEN_PASSES() });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1]!.deliveredSpecs, [A1]);
  assert.deepEqual(calls[2]!.deliveredSpecs, [A2]);
});

test("a pre-exec corrective pass adds the specs it delivers to the ones before it, in the order they first appeared", async () => {
  let captures = 0;
  const calls = await run({
    generations: [lead(A1), lead(B1), lead(B1)],
    capture: async () => ({ specFiles: ["a.spec.ts"], specSources: [++captures === 1 ? AMBIGUOUS : CLEAN], routes: captures === 1 ? OWNERS_TWICE : OWNERS_ONCE }),
    validate: INVALID_ONCE(),
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[2]!.fixCases?.[0]?.name, "static-gate");
  assert.deepEqual(calls[2]!.deliveredSpecs, [A1, B1]);
});

test("a FixLoop lead pass adds the specs it delivers: the round after it is handed them", async () => {
  const calls = await run({
    generations: [lead(A1), lead(A1, B1), lead(A1, B1)],
    execute: FAILS_EVERY_TIME(),
    rewrite: (call, specs, write) => {
      if (call > 1) for (const file of specs) write(file, `// round ${call} ${file}\n`);
    },
    config: { maxRetries: 2 },
  });
  assert.ok(calls.length >= 3);
  assert.deepEqual(calls[1]!.deliveredSpecs, [A1]);
  assert.deepEqual(calls[2]!.deliveredSpecs, [A1, B1]);
});

test("a coverage pass adds the specs it delivers: the reviewer-correction regeneration after it is handed them", async () => {
  const calls = await run({
    generations: [lead(A1), lead(C1), lead(C1)],
    measure: COVERAGE_GAP,
    blocks: (status) => status === "fail",
    review: REJECTS_ONCE(),
    config: { needsReview: true },
  });
  assert.equal(calls.length, 3);
  assert.ok((calls[2]!.reviewCorrections?.length ?? 0) > 0);
  assert.deepEqual(calls[2]!.deliveredSpecs, [A1, C1]);
});

test("a spec the lead delivered and did not declare is carried by its path", async () => {
  const calls = await run({ generations: [scriptedGeneration({ specs: ["a.spec.ts"], approved: true })], validate: INVALID_ONCE() });
  assert.deepEqual(calls[1]!.deliveredSpecs, [{ file: "a.spec.ts" }]);
});

test("a run that delivered no spec file hands its regenerations no delivered-specs key, not an empty one", async () => {
  const calls = await run({ generations: [scriptedGeneration({ specs: ["./"], approved: true })], validate: INVALID_ONCE() });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.fixCases?.[0]?.name, "static-gate");
  assert.equal("deliveredSpecs" in calls[1]!, false);
});

test("a file that a pre-exec contradiction and a Lever-2 contradiction both point at is listed once", async () => {
  const absentButton = `await page.getByRole("button", { name: "Submit" }).click();`;
  let captures = 0;
  const calls = await run({
    generations: [scriptedGeneration({ specs: ["a.spec.ts"], declaredSpecs: [A1], approved: true, specSources: [absentButton] })],
    capture: async () => ({ specFiles: ["a.spec.ts"], specSources: [++captures === 1 ? AMBIGUOUS : CLEAN], routes: captures === 1 ? OWNERS_TWICE : OWNERS_ONCE }),
    execute: async () => ({ verdict: "fail", cases: [{ name: "checkout", status: "fail", detail: "boom", failureDom: "heading: Owners\nbutton: Cancel" }], logs: "" }),
  });
  const regeneration = calls.find((call) => (call.fixCases?.length ?? 0) > 0);
  assert.ok(regeneration, "the FixLoop regenerates");
  assert.equal(regeneration.selectorContradictions?.length, 2, "the pending pre-exec contradiction and Lever-2's");
  assert.deepEqual(regeneration.attributedSpecFiles, ["a.spec.ts"]);
});
