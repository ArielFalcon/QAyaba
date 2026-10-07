/* The specs a run delivers are carried into every regeneration it makes: merged after each generation pass (the lead's declarations refresh, a sidekick's specs join by path alone) and handed to each regeneration as `deliveredSpecs`; a selector contradiction is attributed to the specs that hold its selector as `attributedSpecFiles`. Driven through RunQaUseCase with the ports faked at the boundary. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import type { AgentSession } from "@kernel/ports/agent-runtime.port.ts";
import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
import { RunQaUseCase, type RunQaConfig, type RunQaUseCaseDeps } from "@contexts/qa-run-orchestration/application/run-qa.use-case.ts";
import type {
  ExecutionPort,
  GenerationEnrichment,
  GenerationOutput,
  ObjectiveSignalPort,
  PreExecGroundingPort,
  ReviewPort,
  ValidationPort,
} from "@contexts/qa-run-orchestration/application/ports/index.ts";
import { createCoordinationPort, SidekickExecutor, type DelegationResult } from "@contexts/qa-run-orchestration/application/coordination/index.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";

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
  /** Files that are on disk under the suite directory when the run starts: what a sidekick's claims are checked against. */
  files?: string[];
  /** What each delegation to the sidekick returns, in order; the last one repeats. */
  sidekick?: { delegations: DelegationResult[]; points: NonNullable<RunQaUseCaseDeps["coordinationEnabledPoints"]> };
}

const PASSING: ExecutionPort["execute"] = async () => ({ verdict: "pass", cases: [], logs: "" });
const FAILS_THEN_PASSES = (): ExecutionPort["execute"] => {
  let executions = 0;
  return async () => (++executions === 1 ? { verdict: "fail", cases: [{ name: "checkout", status: "fail", detail: "boom" }], logs: "" } : { verdict: "pass", cases: [], logs: "" });
};
const FAILS_EVERY_TIME = (): ExecutionPort["execute"] => {
  let executions = 0;
  /* A new failing name each round keeps the loop's progress gate open for another regeneration. */
  return async () => ({ verdict: "fail", cases: [{ name: `checkout-${++executions}`, status: "fail", detail: "boom" }], logs: "" });
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

/** The ambiguity the pre-exec gate catches in `source`, which a spec at `a.spec.ts` holds. */
const AMBIGUOUS = `await page.goto("/owners"); await page.getByRole("heading", { name: "Owners" }).click();`;
const CLEAN = `await page.goto("/owners"); await page.getByRole("heading", { name: "Owners" }).click();`;
const OWNERS_TWICE = [{ route: "/owners", nodes: ["heading: Owners", "heading: Owners"] }];
const OWNERS_ONCE = [{ route: "/owners", nodes: ["heading: Owners"] }];

function delegationOf(runId: string, point: string, ...files: string[]): DelegationResult {
  return {
    delegationId: `${runId}-${point}`,
    runId,
    status: "completed",
    summary: "wrote the specs",
    filesChanged: files.map((path) => ({ path })),
    evidence: [],
    validation: [],
    assumptions: [],
    concerns: [],
    unresolvedQuestions: [],
    recommendation: "accept",
    acceptance: point === "fix-loop-regen" ? [{ criterion: 1, status: "unverified" }, { criterion: 2, status: "met" }] : [],
  };
}

function sidekickReturning(results: DelegationResult[]): SidekickExecutor {
  let delegations = 0;
  return new SidekickExecutor({
    runtime: {
      openSession: async () => {
        const result = results[Math.min(delegations++, results.length - 1)]!;
        const session: AgentSession = { async prompt() { return { output: JSON.stringify(result) }; }, async dispose() {} };
        return session;
      },
    },
  });
}

/** Runs the whole use case over a scratch mirror and returns the enrichment of every generate() call, in order. */
async function run(scenario: Scenario): Promise<GenerationEnrichment[]> {
  const mirror = mkdtempSync(join(tmpdir(), "qa-carry-forward-"));
  const specDir = join(mirror, "e2e");
  mkdirSync(specDir, { recursive: true });
  try {
    for (const file of scenario.files ?? []) {
      mkdirSync(dirname(join(mirror, file)), { recursive: true });
      writeFileSync(join(mirror, file), "// spec");
    }
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
      generation: {
        generate: async (_objectives, _specDir, _signal, _diff, enrichment) => {
          calls.push(enrichment ?? {});
          return scenario.generations[Math.min(calls.length - 1, scenario.generations.length - 1)]!;
        },
      },
      review: { review: scenario.review ?? (async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true })) },
      validation: { validate: scenario.validate ?? (async () => ({ ok: true, errors: [] })) },
      execution: { execute: scenario.execute ?? PASSING },
      objectiveSignal: { measure: scenario.measure ?? (async () => ({ status: "unknown", ratio: null })), blocks: scenario.blocks ?? (() => false) },
      publication: { publish: async () => ({ outcome: "pr" }) },
      learning: { fold: async () => {}, retrieve: async () => [] },
      workspace: { prepare: async () => ({ specDir, mirrorDir: mirror }) },
      deployGate: { waitUntilServing: async () => ok(true) },
      runHistory: { save: async () => {} },
      setup: { setup: async () => {} },
      cleanup: { cleanup: async () => {} },
      ...(scenario.capture ? { preExecGrounding: { capture: scenario.capture } } : {}),
      ...(scenario.sidekick
        ? {
            coordination: createCoordinationPort(),
            coordinationEnabledPoints: scenario.sidekick.points,
            sidekick: sidekickReturning(scenario.sidekick.delegations),
          }
        : {}),
      config: { needsReview: false, ...scenario.config },
    });
    await useCase.run({ app: "demo", sha: Sha.of("abc1234"), source: "manual", mode: "diff", target: "e2e", runId: "carry-forward" });
    return calls;
  } finally {
    rmSync(mirror, { recursive: true, force: true });
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

test("a spec that holds the selector of a pre-exec contradiction but raised nothing (it disambiguates the node) is not attributed", async () => {
  const disambiguated = `await page.goto("/owners"); await page.getByRole("heading", { name: "Owners" }).first().click();`;
  const calls = await run({
    generations: [lead(A1, B1)],
    capture: async () => ({ specFiles: ["a.spec.ts", "b.spec.ts"], specSources: [AMBIGUOUS, disambiguated], routes: OWNERS_TWICE }),
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
      scriptedGeneration({ specs: ["b.spec.ts"], declaredSpecs: [B1], approved: true, specSources: [absentButton] }),
    ],
    execute: (() => {
      let executions = 0;
      return async () => ({ verdict: "fail" as const, cases: [{ name: `checkout-${++executions}`, status: "fail" as const, detail: "boom", failureDom: "heading: Owners\nbutton: Cancel" }], logs: "" });
    })(),
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
  const calls = await run({ generations: [lead(A1), lead(B1), lead(B1)], execute: FAILS_EVERY_TIME(), config: { maxRetries: 2 } });
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

test("a sidekick FixLoop round consumes the pending pre-exec contradictions and their attribution: a later lead round carries neither", async () => {
  let captures = 0;
  const calls = await run({
    generations: [lead(A1)],
    files: ["e2e/d.spec.ts"],
    capture: async () => ({ specFiles: ["a.spec.ts"], specSources: [++captures === 1 ? AMBIGUOUS : CLEAN], routes: captures === 1 ? OWNERS_TWICE : OWNERS_ONCE }),
    execute: FAILS_EVERY_TIME(),
    /* The first delegation writes d.spec.ts; the second claims no file on disk, so the lead takes that round. */
    sidekick: { delegations: [delegationOf("carry-forward", "fix-loop-regen", "e2e/d.spec.ts"), delegationOf("carry-forward", "fix-loop-regen")], points: ["fix-loop-regen"] },
    config: { maxRetries: 2 },
  });
  const leadRound = calls.filter((call) => (call.fixCases?.length ?? 0) > 0);
  assert.equal(leadRound.length, 1, "the lead regenerated once in the FixLoop, after the sidekick's round");
  assert.equal("selectorContradictions" in leadRound[0]!, false);
  assert.equal("attributedSpecFiles" in leadRound[0]!, false);
  assert.deepEqual(leadRound[0]!.deliveredSpecs, [A1, { file: "d.spec.ts" }]);
});

/* ── sidekick passes ── */

test("a pre-generate sidekick's specs are carried by path alone, whatever objective its delegation was given", async () => {
  const calls = await run({
    generations: [lead(B1)],
    files: ["e2e/d.spec.ts"],
    sidekick: { delegations: [delegationOf("carry-forward", "pre-generate", "e2e/d.spec.ts")], points: ["pre-generate"] },
    validate: INVALID_ONCE(),
  });
  /* The sidekick wrote the first pass, so the only generate() call is the static-fix regeneration. */
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.fixCases?.[0]?.name, "static-gate");
  assert.deepEqual(calls[0]!.deliveredSpecs, [{ file: "d.spec.ts" }]);
});

test("a FixLoop sidekick's specs join the lead's by path alone, and a spec of the lead's it delivers again keeps the lead's objective", async () => {
  const calls = await run({
    generations: [lead(A1)],
    files: ["e2e/a.spec.ts", "e2e/d.spec.ts"],
    execute: FAILS_THEN_PASSES(),
    sidekick: { delegations: [delegationOf("carry-forward", "fix-loop-regen", "e2e/a.spec.ts", "e2e/d.spec.ts")], points: ["fix-loop-regen"] },
    review: REJECTS_ONCE(),
    config: { needsReview: true },
  });
  /* The sidekick wrote the FixLoop's regeneration, so the first pass and the reviewer-correction regeneration are the two generate() calls. */
  assert.equal(calls.length, 2);
  assert.ok((calls[1]!.reviewCorrections?.length ?? 0) > 0);
  assert.deepEqual(calls[1]!.deliveredSpecs, [A1, { file: "d.spec.ts" }]);
});
