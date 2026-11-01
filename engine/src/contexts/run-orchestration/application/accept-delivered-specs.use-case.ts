/*
 * The acceptance an experiment judges every arm by, so that "what an arm delivered" means the same thing for the pipeline and for a
 * plain agent: the delivered specs are validated by the static gate, executed twice with no retry and no instrumentation, measured for
 * change-coverage by one measurement execution of the passing tests and,
 * when the app requires it, reviewed, and the same decide() and isAccepted() the pipeline publishes by say whether the suite would
 * have been kept. There is no regeneration and no fix loop: an arm that wants its specs to pass has to deliver specs that pass. What
 * "pass" means is the pipeline's own proof rule (`case-proof.ts`): a skipped test or a test marked `test.fail()` in a delivered spec
 * fails the run, and a delivered spec none of whose tests ran and passed is no pass, however the runner's verdict reads.
 */

import type { Sha } from "@kernel/sha.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { hasProof, isRealPass, refuseOutright, verdictAfterRefusal } from "@kernel/case-proof.ts";
import { decide, isAccepted, type RunEvidence } from "../domain/run-decision.service.ts";
import type { ExecutionPort, ValidationPort } from "@contexts/test-execution/application/index.ts";
import { testOfCase, type ObjectiveSignalPort } from "@contexts/objective-signal/application/index.ts";
import { findingTexts, type ReviewPort } from "@contexts/generation/application/index.ts";

/* The runs of the delivered specs: twice, so that a spec that passes once by luck does not count. */
export const ACCEPTANCE_RUNS = 2;

export interface AcceptDeliveredSpecsDeps {
  validation: ValidationPort;
  execution: ExecutionPort;
  objectiveSignal: ObjectiveSignalPort;
  /* Absent: a review that is asked for cannot be given, and nothing is accepted. */
  review?: ReviewPort;
  /* The clock the runs' durations are measured on. Absent: the system clock. */
  now?: () => number;
}

export interface AcceptInput {
  specDir: string;
  /* The specs the arm delivered, relative to the spec directory. */
  specs: readonly string[];
  diff: string;
  changedFiles: readonly string[];
  sha: Sha;
  /* The data prefix the runs are namespaced under (`-acc1`, `-acc2`). */
  namespace: string;
  /* The app requires an independent reviewer's approval, as qa.needsReview does for the pipeline. */
  reviewRequired: boolean;
  shadow?: boolean;
  onFailure?: string;
  signal?: AbortSignal;
}

export interface AcceptanceRun {
  verdict: RunVerdict;
  passed: number;
  failed: number;
  flaky: number;
  ms: number;
}

export interface AcceptanceReport {
  validate: { ok: boolean; infra: boolean; errors: string[] };
  runs: AcceptanceRun[];
  /* The runs combined: both green is a pass, both red a fail, one of each flaky, any that could not execute infra-error. */
  verdict: RunVerdict;
  coverage: { status: "pass" | "fail" | "unknown"; ratio: number | null; blocks: boolean } | null;
  reviewer: { approved: boolean; corrections: string[]; unavailable: boolean } | null;
  decision: { verdict: RunVerdict; sideEffect: string };
  accepted: boolean;
}

export function combineRunVerdicts(runs: readonly RunVerdict[]): RunVerdict {
  if (runs.length === 0) return "skipped";
  if (runs.includes("infra-error")) return "infra-error";
  if (runs.every((v) => v === "pass")) return "pass";
  if (runs.every((v) => v === "fail")) return "fail";
  return "flaky";
}

const count = (cases: readonly QaCase[], status: QaCase["status"]): number => cases.filter((c) => c.status === status).length;

export class AcceptDeliveredSpecsUseCase {
  constructor(private readonly deps: AcceptDeliveredSpecsDeps) {}

  async accept(input: AcceptInput): Promise<AcceptanceReport> {
    const shadow = input.shadow ?? false;
    const onFailure = input.onFailure ?? "github-issue";
    const conclude = (verdict: RunVerdict, rest: Omit<AcceptanceReport, "verdict" | "decision" | "accepted">, ev: Partial<RunEvidence> = {}): AcceptanceReport => {
      const evidence: RunEvidence = { verdict, generating: true, needsReview: input.reviewRequired, blocksPublish: false, shadow, onFailure, ...ev };
      const decision = decide(evidence);
      return { ...rest, verdict, decision: { verdict: decision.verdict, sideEffect: decision.sideEffect }, accepted: isAccepted(evidence) };
    };
    const noValidation = { ok: true, infra: false, errors: [] as string[] };

    if (input.specs.length === 0) return conclude("skipped", { validate: noValidation, runs: [], coverage: null, reviewer: null }, { generating: false });

    const validated = await this.deps.validation.validate(input.specDir);
    const validate = { ok: validated.ok, infra: validated.infra === true, errors: validated.errors };
    if (!validated.ok) return conclude(validate.infra ? "infra-error" : "invalid", { validate, runs: [], coverage: null, reviewer: null });

    const runs: AcceptanceRun[] = [];
    const executions: Array<{ verdict: RunVerdict; cases: QaCase[] }> = [];
    const now = this.deps.now ?? Date.now;
    for (let n = 1; n <= ACCEPTANCE_RUNS; n++) {
      const started = now();
      const result = await this.deps.execution.execute(input.specDir, {
        specFiles: [...input.specs],
        namespace: `${input.namespace}-acc${n}`,
        retries: 0,
        purpose: "acceptance",
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const judged = refuseOutright(result, input.specs);
      const cases = [...judged.cases, ...judged.refused];
      /* A runner that says pass over a refused test, or over a delivered spec with no real passing case, has not shown the suite passing. */
      const unproven = result.verdict === "pass" && !input.specs.every((spec) => hasProof(spec, judged.cases));
      const runVerdict: RunVerdict = unproven ? "fail" : verdictAfterRefusal(result.verdict, judged);
      executions.push({ verdict: runVerdict, cases });
      runs.push({ verdict: runVerdict, passed: cases.filter(isRealPass).length, failed: count(cases, "fail"), flaky: count(cases, "flaky"), ms: now() - started });
    }
    const verdict = combineRunVerdicts(runs.map((r) => r.verdict));
    if (verdict !== "pass") return conclude(verdict, { validate, runs, coverage: null, reviewer: null });

    const first = executions[0]!;
    const coverage = await this.measure(input, first.cases);
    const blocks = coverage.blocks;

    if (!input.reviewRequired) return conclude(verdict, { validate, runs, coverage, reviewer: null }, { blocksPublish: blocks });
    if (!this.deps.review) return conclude(verdict, { validate, runs, coverage, reviewer: null }, { blocksPublish: blocks, reviewerApproved: false });

    const review = await this.deps.review.review(input.specDir, first.cases, input.diff, {});
    const unavailable = review.unavailable === true;
    /* The pipeline's own gate: approved with no blocking correction; a verdict that could not be read, or no verdict at all, is no approval. */
    const approved = !unavailable && review.parsed !== false && review.approved === true && (review.blockingCount ?? review.findings.length) === 0;
    return conclude(verdict, { validate, runs, coverage, reviewer: { approved, corrections: findingTexts(review.findings), unavailable } }, { blocksPublish: blocks, reviewerApproved: approved });
  }

  /*
   * The runs that judged measured nothing (RFC-0015): the first run's passing tests run once more, with coverage on and no retry, under
   * `<namespace>-measure`, and that execution is what is measured. A test that fails only there credits nothing; a measurement that
   * could not run, or did not run every test it was given, measured nothing and the coverage is unknown. The verdict stands either way.
   */
  private async measure(input: AcceptInput, judged: readonly QaCase[]): Promise<NonNullable<AcceptanceReport["coverage"]>> {
    const unknown = { status: "unknown" as const, ratio: null, blocks: this.deps.objectiveSignal.blocks("unknown") };
    const passing = judged.filter(isRealPass);
    const specFiles = [...new Set(passing.flatMap((c) => (c.file !== undefined ? [c.file] : [])))];
    if (passing.length === 0 || specFiles.length === 0) return unknown;
    const namespace = `${input.namespace}-measure`;
    const result = await this.deps.execution.execute(input.specDir, {
      specFiles,
      tests: [...new Set(passing.map((c) => testOfCase(c.name)))],
      namespace,
      retries: 0,
      coverage: true,
      purpose: "measurement",
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const byName = new Map(result.cases.map((c) => [c.name, c]));
    if (result.verdict === "infra-error" || passing.some((c) => !byName.has(c.name))) return unknown;
    const green = passing.filter((c) => isRealPass(byName.get(c.name)!));
    const red = passing.filter((c) => !isRealPass(byName.get(c.name)!));
    const measured = await this.deps.objectiveSignal.measure(
      BlastRadius.of(input.sha, [...input.changedFiles]),
      input.specDir,
      input.diff,
      green.map((c) => c.name),
      { namespace, ...(red.length > 0 ? { exceptTests: red.map((c) => testOfCase(c.name)) } : {}) },
    );
    return { status: measured.status, ratio: measured.ratio, blocks: this.deps.objectiveSignal.blocks(measured.status) };
  }
}
