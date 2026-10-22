/* FixLoop aggregate: triage → selector check → adjudicate → regen → accept (validate + execute the changed specs; a rejected or capped round restores its bytes), with absentKeys short-circuit and a fewest-failures regression guard that restores the best round's bytes too. Triage and the typed test-correct claim are capabilities the caller grants only while the review-loop integrity switch is on. CycleBudget/WallClockBudget are forwarded unread into every generate() call — this aggregate neither ticks nor inspects them, and neither does the generation adapter: CycleBudget.ceiling is telemetry-only, and WallClockBudget.exhausted() is checked directly by run-qa.use-case.ts before each regen round, not by this aggregate or the generator. break-needs-human exits without setting realBugDetected; the caller labels the Issue. Filtered-retry scopes to failing specs only when change-coverage will not measure this run. */

import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { RunMode } from "@kernel/run-mode.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { CycleBudget } from "./cycle-budget.ts";
import type { WallClockBudget } from "./wall-clock-budget.ts";
import { adjudicate, classifyRuntimeErrors, type AdjFailureClass, type AdjudicatorEvidence, type AdjudicatorVerdict, ADJ_CLASS, ADJ_ACTION, ADJ_CONFIDENCE } from "./adjudicate.service.ts";
import { decideProgress, classifyFailure, bestRound, isLikelyRealBug, type RoundResult } from "./helpers/progress-gate.ts";
import type { ContradictionOrigin, SpecSelectorFindings } from "./helpers/selector-check.ts";
import type { ContractFeedback } from "./contract-feedback.ts";


export interface FixLoopRun {
  verdict: RunVerdict;
  cases: QaCase[];
}

export interface FixLoopGenerateInput {
  fixCases: QaCase[];
  selectorContradictions?: string[];
  /* The spec that raised each of selectorContradictions, by its index among the spec sources the check read (the previous regeneration's). Absent when the check does not say. */
  selectorContradictionOrigins?: ContradictionOrigin[];
  domSnapshot?: string;
  /* A-2b: the intent lock's deltas on the previous round, handed back as facts. Absent when that round broke no contract. */
  contractFeedback?: readonly ContractFeedback[];
  /* CycleBudget/WallClockBudget are forwarded unread into generate() — this aggregate never ticks or inspects them, and neither does the generation adapter (see this file's header comment). */
  cycleBudget: CycleBudget;
  wallClockBudget: WallClockBudget;
}
export interface FixLoopGenerateResult {
  specs: string[];
  approved: boolean;
  note?: string;
  reexploreNavigations?: number;
  specSources?: string[];
  /* This round's flow/objective metadata. Absent/empty when unread — never fabricated. Caller prefers lastSpecMetas over the pre-loop generation once the loop has rewritten specs. */
  specMetas?: { flow?: string; objective?: string }[];
  /* The generator's typed claim that the test is correct and the app/environment is not. A claim, never evidence: the loop verifies it against the round's own artifacts. */
  testCorrect?: { cause: "env" | "app"; reason: string };
}
export interface FixLoopGenerationPort {
  generate(input: FixLoopGenerateInput): Promise<FixLoopGenerateResult>;
}

export interface FixLoopExecuteInput {
  namespace: string;
  specFiles?: string[];
  /* Attempts after a failure; 0 is a single attempt. Absent: the suite's own config decides. */
  retries?: number;
}
export interface FixLoopExecutionPort {
  execute(input: FixLoopExecuteInput): Promise<FixLoopRun>;
}

export interface FixLoopSelectorCheckPort {
  /* `origins`, when the check gives them, are the spec that raised each of the findings' contradictions. */
  check(specSources: string[], trees: string[][]): SpecSelectorFindings & { origins?: ContradictionOrigin[] };
}

export interface FixLoopDeps {
  execution: FixLoopExecutionPort;
  generation: FixLoopGenerationPort;
  selectorCheck: FixLoopSelectorCheckPort;
  /**
   * The run's acceptance of an e2e round: the pre-turn snapshot, the changed-spec validation and
   * execution, and the bytes of the round that produced the best run. Always wired by the run (B-9:
   * the byte restore is a correctness fix, never behind the switch); absent only in aggregate unit
   * tests that have no working copy, which keep the pre-acceptance retry path below.
   */
  acceptance?: FixLoopAcceptancePort;
  /** Pre-acceptance retry path, kept for a caller with no working copy (aggregate unit tests). */
  revalidate?: (specDir: string) => Promise<{ ok: boolean; errors: string[] }>;
}

/**
 * Acceptance of one fix-loop round. The run owns the snapshot and the execution; the aggregate sees
 * an opaque round token and matches it to the best run it keeps.
 */
export interface FixLoopAcceptancePort {
  /** Before the turn: capture the suite bytes the turn may change. */
  begin(): Promise<unknown>;
  /**
   * After the turn: validate the changed specs and execute them once. A round whose execution fails
   * is still accepted for an iterative loop (its cases are what the next round repairs); a validation
   * failure, an infra-error or the cap is rejected and has the pre-turn bytes restored.
   */
  accept(input: {
    /** The token `begin()` returned for this round. */
    round: unknown;
    /** The specs the turn delivered, suite-relative. */
    specs: readonly string[];
    /** The execution namespace: `${runId}-r<n>`. */
    namespace: string;
  }): Promise<FixLoopAcceptanceOutcome>;
  /** Put back the accepted bytes of the round whose token this is (the best run's snapshot). */
  restore(token: unknown): Promise<void>;
}

export type FixLoopAcceptanceOutcome =
  | {
      kind: "accepted";
      /** The specs the turn actually changed (created, rewritten or deleted), suite-relative. */
      changedSpecFiles: readonly string[];
      /** The execution of the changed specs; absent when every change already held a green proof. */
      execution?: FixLoopRun;
      /** The bytes this round leaves on disk, for restoring it if it is the best run. */
      accepted: unknown;
    }
  | {
      kind: "rejected";
      reason: string;
      /** The execution that rejected the round (an infra-error), when one ran. */
      execution?: FixLoopRun;
      /** The contract deltas that rejected the round: the loop hands them to the next round as facts (A-2b). */
      violations?: readonly ContractFeedback[];
    }
  | { kind: "cap" };

/**
 * What the caller grants the loop while the review-loop integrity switch is on: the evidence the
 * triage needs and a cap for the one re-execution it may spend. Absent means the switch is off, and
 * neither the triage nor a typed test-correct claim is read.
 */
export interface FixLoopIntegrity {
  /** Whether the current bytes of a spec file were seen passing in this run (the run_spec closure, or a proof the ledger already holds). */
  hasGreenProof(specFile: string): Promise<boolean>;
  /** Claims one execution from the run's acceptance cap; false when none is left. */
  spendExecution(): boolean;
  /** Milliseconds left before the run's deadline; undefined when none is armed. */
  remainingMs(): number | undefined;
}


export interface FixLoopInput {
  initialRun: FixLoopRun;
  isCode: boolean;
  generating: boolean;
  mode: RunMode;
  objectiveSource: string[];
  maxRetries: number;
  /* False retires the regeneration and the re-execution, which only repeat what the generator already saw pass: the failure is still adjudicated once, so the Issue carries its class and a defect or an infrastructure fault is still recognised. Absent: true. */
  regenerate?: boolean;
  cycleBudget: CycleBudget;
  wallClockBudget: WallClockBudget;
  devHealthy: () => Promise<boolean>;
  namespace: string;
  initialSpecSources?: string[];
  /* True only when this run will be measured for change-coverage — filtering a retry would then undercount passing specs. Defaults to false (never filter). */
  coverageWillMeasure?: boolean;
  failureDomSnapshot?: string;
  specDir?: string;
  /* Present only while the review-loop integrity switch is on: enables triage and reads a typed test-correct claim. */
  integrity?: FixLoopIntegrity;
}

export interface FixLoopResult {
  run: FixLoopRun;
  retries: number;
  realBugDetected: boolean;
  /* The first round's absentKeys.size: the initial failure's divergence evidence. A later round's count does not overwrite it. */
  absentSelectors: number;
  /* Last adjudicator verdict for Issue labeling by the caller. undefined when the loop never ran. */
  lastAdjudicatorVerdict: AdjudicatorVerdict | undefined;
  coverageNamespace: string;
  /* Last regen round's specMetas at loop exit. undefined when the loop never regenerated — never fabricated. */
  lastSpecMetas: { flow?: string; objective?: string }[] | undefined;
  /* The loop ended on a conclusive dev_not_rendered: the run is an infra-error of the precondition class. */
  preconditionFailed: boolean;
  /* Typed test-correct claims the loop rejected as unverified evidence (each asked for another repair). */
  rejectedClaims: number;
}

const failCount = (r: FixLoopRun): number => r.cases.filter((c) => c.status === "fail").length;

/* Suite-relative spec path in one canonical form: forward slashes, no leading "./". */
function normalizeSpecPath(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

/* An accepted round's execution replaces its changed files' cases; every other file keeps its last result. The merged verdict is never greener than the execution that just ran. */
function mergeAcceptedRound(current: FixLoopRun, outcome: Extract<FixLoopAcceptanceOutcome, { kind: "accepted" }>): FixLoopRun {
  const changed = new Set(outcome.changedSpecFiles.map(normalizeSpecPath));
  const reported = new Set(
    (outcome.execution?.cases ?? [])
      .map((c) => c.file)
      .filter((file): file is string => file !== undefined)
      .map(normalizeSpecPath),
  );
  const cases = [
    ...current.cases.filter((c) => {
      if (c.file === undefined) return true;
      const file = normalizeSpecPath(c.file);
      return !changed.has(file) && !reported.has(file);
    }),
    ...(outcome.execution?.cases ?? []),
  ];
  const verdict: RunVerdict =
    outcome.execution?.verdict === "fail" || cases.some((c) => c.status === "fail")
      ? "fail"
      : outcome.execution?.verdict === "flaky" || cases.some((c) => c.status === "flaky")
        ? "flaky"
        : "pass";
  return { verdict, cases };
}

function buildFailureDomLines(failureDom: string | undefined): string[] {
  if (!failureDom) return [];
  return failureDom.split("\n").filter((l) => l.trim());
}

/* A typed test-correct claim is evidence only when the round's own artifacts already show the app (or the environment) at fault. Env has one witness: the conclusive triage read. */
function verifiedTestCorrectReason(
  claim: { cause: "env" | "app" },
  evidence: {
    fiveXx: number[];
    failureClasses: AdjFailureClass[];
    runtimeErrorsByCase: { type: string; text: string }[][];
    devNotRendered?: "conclusive" | "inconclusive";
  },
): string | undefined {
  if (claim.cause === "env") {
    return evidence.devNotRendered === "conclusive" ? "the second read confirmed DEV did not render the target" : undefined;
  }
  if (evidence.fiveXx.length > 0) {
    return `the run saw a ${evidence.fiveXx[evidence.fiveXx.length - 1]} server error`;
  }
  for (const errors of evidence.runtimeErrorsByCase) {
    const runtime = classifyRuntimeErrors(errors);
    if (runtime.appDefect) return `the run captured ${runtime.reasons[0]}`;
  }
  if (evidence.failureClasses.some((failure) => failure === "value-mismatch")) {
    return "at least one assertion failed on a value mismatch";
  }
  return undefined;
}

export class FixLoop {
  constructor(private readonly deps: FixLoopDeps) {}

  async run(input: FixLoopInput): Promise<FixLoopResult> {
    let run = input.initialRun;
    let retries = 0;
    let prevRound: RoundResult | null = null;
    let bestRunSoFar: FixLoopRun = run;
    /* The accepted bytes of the best run, and whether a round has ever captured them. */
    let bestToken: unknown;
    let hasBestToken = false;
    let realBugDetected = false;
    let adjVerdict: AdjudicatorVerdict | undefined;
    let coverageNs = input.namespace;
    let absentSelectors = 0;
    let preconditionFailed = false;
    let rejectedClaims = 0;
    /* The one triage re-execution this loop may spend. */
    let triaged = false;
    /* A rejected test-correct claim earns one repair even when the progress gate would stop the round. */
    let claimRejected = false;
    /* A round the contract refused never executed, so the progress gate would read it as no progress: it earns one repair all the same. */
    let contractRejected = false;
    /* A round the contract refused leaves its deltas for the next round; an accepted round clears them. */
    let contractFeedback: readonly ContractFeedback[] | undefined;
    /* Only what a later round reads from the previous regeneration. */
    let lastRegenResult: Pick<FixLoopGenerateResult, "specSources" | "reexploreNavigations" | "specMetas"> | undefined =
      input.initialSpecSources?.length ? { specSources: input.initialSpecSources } : undefined;

    const regenerate = input.regenerate !== false;
    const maxRetries = regenerate ? input.maxRetries : 1;

    for (let retry = 0; retry < maxRetries && run.verdict === "fail" && input.generating; retry++) {
      const failed = run.cases.filter((c) => c.status === "fail");

      const failedTrees = failed
        .map((c) => buildFailureDomLines(c.failureDom))
        .filter((t) => t.length > 0);
      const haveTrees = !input.isCode && failedTrees.length > 0;
      const specSources = haveTrees ? (lastRegenResult?.specSources ?? []) : [];
      const lever2 = this.deps.selectorCheck.check(specSources, failedTrees);
      const selectorContradictions = lever2.contradictions;
      const absentKeys = lever2.absentKeys;
      const anyVerifiedPresent = lever2.anyVerifiedPresent;
      const anyNonExtractableLocator = lever2.anyNonExtractable;
      const anyUnverifiableSelector = lever2.anyUnverifiable;

      /* The first round's absentKeys is the initial failure's divergence evidence; later rounds never overwrite it. */
      if (retry === 0) absentSelectors = absentKeys.size;

      const lever2Flips = prevRound ? [...prevRound.absentSelectors].filter((k) => !absentKeys.has(k)).length : 0;

      const curRound: RoundResult = {
        failingNames: new Set(failed.map((c) => c.name)),
        failingCount: failed.length,
        absentSelectors: absentKeys,
        lever2Flips,
        reexploreNavigations: lastRegenResult?.reexploreNavigations ?? 0,
      };
      const gate = claimRejected
        ? { spend: true, reason: "a rejected test-correct claim is not evidence — asking for the repair" }
        : contractRejected
          ? { spend: true, reason: "the contract refused the previous round before it ran: asking for the repair the violations name" }
          : decideProgress(prevRound, curRound);
      claimRejected = false;
      contractRejected = false;

      const allUnique =
        anyVerifiedPresent &&
        absentKeys.size === 0 &&
        !anyNonExtractableLocator &&
        !anyUnverifiableSelector &&
        !selectorContradictions.some((c) => c.includes("MULTIPLE"));

      /* Fresh devHealthy() at this snapshot; a separate fresh call happens before retry-execute — never shared or memoized. */
      const devHealthyNow = input.isCode ? true : await input.devHealthy();
      /* A missing detail reads as "" — any placeholder text would classify the same ("other", not infra). */
      const failureDetails = failed.map((c) => c.detail ?? "");
      const failureClasses = failureDetails.map((detail) => classifyFailure(detail));
      const httpStatuses = failed.map((c) => c.httpStatus);
      const runtimeErrorsByCase = failed.map((c) => c.runtimeErrors ?? []);
      const fiveXx = httpStatuses.filter((status): status is number => status !== undefined && status >= 500 && status <= 599);

      /*
       * Triage: a failure whose target is verifiably absent while the same bytes have a green proof
       * is either DEV not rendering the change or an environment fault — never a test defect. One
       * re-execution (no retries) reads it a second time; a conclusive read ends the loop as a
       * precondition, an inconclusive one as a possible environment cause. Only while the switch is on.
       */
      let devNotRendered: AdjudicatorEvidence["devNotRendered"];
      if (
        !triaged &&
        input.integrity &&
        !input.isCode &&
        absentKeys.size > 0 &&
        failureClasses.length > 0 &&
        failureClasses.every((failure) => failure === "locator" || failure === "timeout") &&
        failed.every((c) => !!c.file)
      ) {
        const failedFiles = [...new Set(failed.map((c) => c.file as string))];
        const proofs = await Promise.all(failedFiles.map((file) => input.integrity!.hasGreenProof(file)));
        if (proofs.every(Boolean)) {
          triaged = true;
          const remaining = input.integrity.remainingMs();
          if ((remaining !== undefined && remaining <= 0) || !input.integrity.spendExecution()) {
            devNotRendered = "inconclusive";
          } else {
            const triageRun = await this.deps.execution.execute({
              namespace: `${input.namespace}-triage`,
              specFiles: failedFiles,
              retries: 0,
            });
            if (triageRun.verdict === "pass" || triageRun.verdict === "flaky") {
              /* The same bytes passed on a second read: intermittent, as a retry that passes is today. */
              const reportedFiles = new Set(triageRun.cases.map((c) => c.file));
              run = {
                verdict: "flaky",
                cases: [...run.cases.filter((c) => !reportedFiles.has(c.file)), ...triageRun.cases],
              };
              break;
            }
            const triageFailed = triageRun.cases.filter((c) => c.status === "fail");
            const triageTrees = triageFailed.map((c) => buildFailureDomLines(c.failureDom)).filter((tree) => tree.length > 0);
            const triageAbsentKeys = this.deps.selectorCheck.check(specSources, triageTrees).absentKeys;
            const stable =
              triageRun.verdict === "fail" && [...absentKeys].every((key) => triageAbsentKeys.has(key));
            devNotRendered = stable ? "conclusive" : "inconclusive";
          }
        }
      }

      const evidence: AdjudicatorEvidence = {
        isCode: input.isCode,
        allUnique,
        failureDetails,
        failureClasses,
        absentKeysCount: absentKeys.size,
        gateSpend: gate.spend,
        gateReason: gate.reason,
        devHealthy: devHealthyNow,
        mode: input.mode,
        objectiveSource: input.objectiveSource,
        failingFiles: failed.map((c) => c.file),
        httpStatuses,
        runtimeErrorsByCase,
        ...(devNotRendered ? { devNotRendered } : {}),
      };
      const verdict = adjudicate(evidence);
      adjVerdict = verdict;

      if (verdict.action === ADJ_ACTION.BREAK_ISSUE) {
        if (verdict.class === ADJ_CLASS.RUNNER_INFRA || verdict.class === ADJ_CLASS.DEV_INFRA) {
          run = { verdict: "infra-error", cases: [] };
        } else if (verdict.class === ADJ_CLASS.DEV_NOT_RENDERED) {
          run = { verdict: "infra-error", cases: [] };
          preconditionFailed = true;
        } else {
          realBugDetected = true;
        }
      }
      /* Any break-* action ends the loop; for BREAK_NEEDS_HUMAN adjVerdict is already set — the caller labels the Issue. */
      if (verdict.action !== ADJ_ACTION.CONTINUE) break;
      if (!regenerate) break;

      prevRound = curRound;

      /*
       * The round's bytes, captured before the turn: a rejected or capped round is restored from them,
       * and the first round's are the initial run's bytes if that run stays the best. The namespace is
       * unique per attempt so a retry cannot collide with its own prior attempt's test data.
       */
      const roundNs = `${input.namespace}-r${retry + 1}`;
      const roundToken = !input.isCode && this.deps.acceptance ? await this.deps.acceptance.begin() : undefined;
      if (!input.isCode && this.deps.acceptance && !hasBestToken) {
        bestToken = roundToken;
        hasBestToken = true;
      }

      /* Regeneration with review:skip. Cycle/wall-clock budgets are forwarded unread (see the header). */
      const result = await this.deps.generation.generate({
        fixCases: failed,
        ...(selectorContradictions.length > 0 ? { selectorContradictions } : {}),
        ...(selectorContradictions.length > 0 && lever2.origins ? { selectorContradictionOrigins: lever2.origins } : {}),
        ...(input.failureDomSnapshot ? { domSnapshot: input.failureDomSnapshot } : {}),
        ...(contractFeedback ? { contractFeedback } : {}),
        cycleBudget: input.cycleBudget,
        wallClockBudget: input.wallClockBudget,
      });
      /*
       * A typed test-correct claim is read only on a turn that delivered no bytes. It is never
       * evidence: the loop verifies it against this round's artifacts; unverified, it earns one
       * repair and the claim is not counted as a fix. Bounded by the loop's retry cap.
       */
      const claim = result.specs.length === 0 && input.integrity ? result.testCorrect : undefined;
      if (claim) {
        const verified = verifiedTestCorrectReason(claim, {
          fiveXx,
          failureClasses,
          runtimeErrorsByCase,
          ...(devNotRendered ? { devNotRendered } : {}),
        });
        if (verified) {
          if (claim.cause === "env") {
            run = { verdict: "infra-error", cases: [] };
            preconditionFailed = true;
            adjVerdict = {
              class: ADJ_CLASS.DEV_NOT_RENDERED,
              confidence: ADJ_CONFIDENCE.HIGH,
              action: ADJ_ACTION.BREAK_ISSUE,
              reason: `Environment confirmed: the generator reported the test correct (${claim.reason}); ${verified}.`,
            };
          } else {
            realBugDetected = true;
            adjVerdict = {
              class: ADJ_CLASS.APP_DEFECT,
              confidence: ADJ_CONFIDENCE.HIGH,
              action: ADJ_ACTION.BREAK_ISSUE,
              reason: `App defect confirmed: the generator reported the test correct (${claim.reason}); ${verified}.`,
            };
          }
          break;
        }
        rejectedClaims++;
        claimRejected = true;
        continue;
      }
      lastRegenResult = result;

      if (result.specs.length === 0) {
        /* Retry agent produced no fixes; keep the original verdict. */
        break;
      }
      retries++;

      /* Absent selectors: regenerate without re-executing; loop to the next round. Bounded by the same for-header cap + gate. */
      if (!input.isCode && absentKeys.size > 0) {
        continue;
      }

      /* Whether this round's acceptance accepted it, and the bytes it leaves for the best-run restore. */
      let roundAccepted = false;
      let acceptedToken: unknown;

      if (input.isCode) {
        /* Code mode: re-run the repo's own test suite directly — this branch never calls deps.revalidate (that seam is e2e-only, below). Code-mode pre-execution compile validation lives in the pipeline's validation phase (CodeValidationStrategy), not per-retry here; a code retry's compile failure surfaces through the execute() run itself (exit-code classification). */
        const codeRun = await this.deps.execution.execute({ namespace: input.namespace });
        run = codeRun;
      } else if (this.deps.acceptance) {
        if (!(await input.devHealthy())) break; /* DEV unhealthy before the round's execution */

        const outcome = await this.deps.acceptance.accept({
          round: roundToken,
          specs: result.specs,
          namespace: roundNs,
        });
        if (outcome.kind === "rejected") {
          /*
           * The contract refused the round: its bytes are already restored, and the deltas it found are
           * the next round's facts. The rejected turn already spent its retry, so the loop stays inside
           * the same cap (A-2b).
           */
          if (outcome.violations?.length) {
            contractFeedback = outcome.violations;
            contractRejected = true;
            continue;
          }
          /*
           * A validation failure or an infra-error: the prior verdict and bytes stand. A live
           * execution that failed while DEV went unhealthy is the run's infra-error, as before.
           */
          if (
            outcome.execution?.verdict === "infra-error" ||
            (outcome.execution?.verdict === "fail" && !(await input.devHealthy()))
          ) {
            run = { verdict: "infra-error", cases: [] };
          }
          break;
        }
        if (outcome.kind === "cap") break; /* the prior verdict and bytes stand (B-7) */

        run = mergeAcceptedRound(run, outcome);
        contractFeedback = undefined;
        coverageNs = roundNs;
        roundAccepted = true;
        acceptedToken = outcome.accepted;
      } else {
        /* Pre-acceptance retry path, for a caller with no working copy (aggregate unit tests). The run always wires `acceptance`. */
        if (this.deps.revalidate) {
          const reValidation = await this.deps.revalidate(input.specDir ?? "");
          if (!reValidation.ok) break; /* retry validation failed; keep original verdict */
        }
        if (!(await input.devHealthy())) break; /* DEV unhealthy before retry execution */

        const retryNs = `${input.namespace}-r${retry + 1}`;

        /* Scope the re-run to failing spec files only when change-coverage will not measure this run. */
        const failedSpecFiles = [
          ...new Set(run.cases.filter((c) => c.status === "fail" && c.file).map((c) => c.file as string)),
        ];
        const allFailedHaveFile = run.cases.filter((c) => c.status === "fail").every((c) => !!c.file);
        const failedSpecPaths = new Set(failedSpecFiles.map(normalizeSpecPath));
        const regenHasOutsiders = result.specs.some((spec) => !failedSpecPaths.has(normalizeSpecPath(spec)));
        /* Any regen spec outside the failing set means filtering execute() to the stale failing
           set would never run the file the regen actually wrote — even when some regen specs
           also overlap the failing set. Only "regen touched nothing but already-failing files"
           is safe to filter. Paths are compared whole (suite-relative), never by file name: a
           same-named spec in another folder is a different file, and any path that does not
           name a failing file exactly re-runs everything (running more is always safe). */
        const regenStayedInFailedSet = !regenHasOutsiders;
        const canFilter =
          allFailedHaveFile &&
          failedSpecFiles.length > 0 &&
          regenStayedInFailedSet &&
          !(input.coverageWillMeasure ?? false);

        const retryRun = await this.deps.execution.execute({
          namespace: retryNs,
          ...(canFilter ? { specFiles: failedSpecFiles } : {}),
        });

        if (retryRun.verdict === "fail" && !(await input.devHealthy())) {
          run = { verdict: "infra-error", cases: [] };
          break;
        }

        /* A retry the runner could not complete (infra-error) is never merged: the run ends
           inconclusive exactly as an unfiltered retry would, so a spec that never re-ran cannot
           ride on the carried-forward passes into a green verdict. */
        if (canFilter && retryRun.verdict !== "infra-error") {
          /* Every file the retry reported (file-less cases count as one group) replaces its earlier
             cases; every other file keeps its last result — including a re-run failing spec the
             retry reported nothing for, whose last observed result is still its failure. */
          const reportedFiles = new Set(retryRun.cases.map((c) => c.file));
          const carriedForward = run.cases.filter((c) => !reportedFiles.has(c.file));
          const mergedCases = [...carriedForward, ...retryRun.cases];
          /* The merge is never greener than the runner's own verdict for the retry. */
          const mergedVerdict: RunVerdict =
            retryRun.verdict === "fail" || mergedCases.some((c) => c.status === "fail")
              ? "fail"
              : retryRun.verdict === "flaky" || mergedCases.some((c) => c.status === "flaky")
                ? "flaky"
                : "pass";
          run = { verdict: mergedVerdict, cases: mergedCases };
        } else {
          run = retryRun;
        }
        coverageNs = retryNs;
      }

      /* Keep the best EXECUTED run seen so far, with the bytes that produced it. infra-error is never "better". */
      if (run.verdict !== "infra-error") {
        const best = bestRound([
          { failingCount: failCount(bestRunSoFar), run: bestRunSoFar },
          { failingCount: failCount(run), run },
        ])!.run;
        bestRunSoFar = best;
        /* Only an accepted round has bytes of its own; the initial run's are the first pre-turn snapshot. */
        if (roundAccepted && best === run) {
          bestToken = acceptedToken;
          hasBestToken = true;
        }
      }
    }

    /* Restore bestRunSoFar after the loop, bytes included — skipped when the real-bug branch fired or the loop ended on infra-error. */
    if (
      !realBugDetected &&
      run.verdict !== "infra-error" &&
      failCount(bestRunSoFar) < failCount(run)
    ) {
      /* The best round's own bytes go back first: a failed restore must not leave the worse round's bytes under the best cases. */
      if (this.deps.acceptance && hasBestToken) await this.deps.acceptance.restore(bestToken);
      run = bestRunSoFar;
    }

    return {
      run,
      retries,
      realBugDetected,
      absentSelectors,
      lastAdjudicatorVerdict: adjVerdict,
      coverageNamespace: coverageNs,
      lastSpecMetas: lastRegenResult?.specMetas,
      preconditionFailed,
      rejectedClaims,
    };
  }
}

export { isLikelyRealBug };
