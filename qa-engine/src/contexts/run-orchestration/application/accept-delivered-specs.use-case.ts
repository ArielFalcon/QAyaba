/*
 * The acceptance an experiment judges every arm by, so that "what an arm delivered" means the same thing for the pipeline and for a
 * plain agent: the delivered specs are validated by the static gate, executed twice with no retry, measured for change-coverage and,
 * when the app requires it, reviewed, and the same decide() and isAccepted() the pipeline publishes by say whether the suite would
 * have been kept. There is no regeneration and no fix loop: an arm that wants its specs to pass has to deliver specs that pass.
 */

import type { Sha } from "@kernel/sha.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { decide, isAccepted, type RunEvidence } from "../domain/run-decision.service.ts";
import type { ExecutionPort, ValidationPort } from "@contexts/test-execution/application/index.ts";
import type { ObjectiveSignalPort } from "@contexts/objective-signal/application/index.ts";
import type { ReviewPort } from "@contexts/generation/application/index.ts";

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
      const evidence: RunEvidence = { verdict, generating: true, needsReview: input.reviewRequired, reviewerApproved: true, blocksPublish: false, shadow, onFailure, ...ev };
      const decision = decide(evidence);
      return { ...rest, verdict, decision: { verdict: decision.verdict, sideEffect: decision.sideEffect }, accepted: isAccepted(evidence) };
    };
    const noValidation = { ok: true, infra: false, errors: [] as string[] };

    if (input.specs.length === 0) return conclude("skipped", { validate: noValidation, runs: [], coverage: null, reviewer: null }, { generating: false });

    const validated = await this.deps.validation.validate(input.specDir, [...input.changedFiles]);
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
        ...(input.signal ? { signal: input.signal } : {}),
      });
      executions.push({ verdict: result.verdict, cases: result.cases });
      runs.push({ verdict: result.verdict, passed: count(result.cases, "pass"), failed: count(result.cases, "fail"), flaky: count(result.cases, "flaky"), ms: now() - started });
    }
    const verdict = combineRunVerdicts(runs.map((r) => r.verdict));
    if (verdict !== "pass") return conclude(verdict, { validate, runs, coverage: null, reviewer: null });

    const first = executions[0]!;
    const measured = await this.deps.objectiveSignal.measure(
      BlastRadius.of(input.sha, [...input.changedFiles]),
      input.specDir,
      input.diff,
      first.cases.filter((c) => c.status === "pass").map((c) => c.name),
      { namespace: `${input.namespace}-acc1` },
    );
    const blocks = this.deps.objectiveSignal.blocks(measured.status);
    const coverage = { status: measured.status, ratio: measured.ratio, blocks };

    if (!input.reviewRequired) return conclude(verdict, { validate, runs, coverage, reviewer: null }, { blocksPublish: blocks });
    if (!this.deps.review) return conclude(verdict, { validate, runs, coverage, reviewer: null }, { blocksPublish: blocks, reviewerApproved: false });

    const review = await this.deps.review.review(input.specDir, first.cases, input.diff, {});
    const unavailable = review.unavailable === true;
    /* The pipeline's own gate: approved with no blocking correction; a verdict that could not be read, or no verdict at all, is no approval. */
    const approved = !unavailable && review.parsed !== false && review.approved && (review.blockingCount ?? review.corrections.length) === 0;
    return conclude(verdict, { validate, runs, coverage, reviewer: { approved, corrections: review.corrections, unavailable } }, { blocksPublish: blocks, reviewerApproved: approved });
  }
}
