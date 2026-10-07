/* FixLoop aggregate: selector check → adjudicate → regen → re-execute, with absentKeys short-circuit and a fewest-failures regression guard. CycleBudget/WallClockBudget are forwarded unread into every generate() call — this aggregate neither ticks nor inspects them, and neither does the generation adapter: CycleBudget.ceiling is telemetry-only, and WallClockBudget.exhausted() is checked directly by run-qa.use-case.ts before each regen round, not by this aggregate or the generator. break-needs-human exits without setting realBugDetected; the caller labels the Issue. Filtered-retry scopes to failing specs only when change-coverage will not measure this run. */

import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { RunMode } from "@kernel/run-mode.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { CycleBudget } from "./cycle-budget.ts";
import type { WallClockBudget } from "./wall-clock-budget.ts";
import { adjudicate, type AdjudicatorEvidence, type AdjudicatorVerdict, ADJ_CLASS, ADJ_ACTION } from "./adjudicate.service.ts";
import { decideProgress, classifyFailure, bestRound, isLikelyRealBug, type RoundResult } from "./helpers/progress-gate.ts";
import type { ContradictionOrigin, SpecSelectorFindings } from "./helpers/selector-check.ts";


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
}
export interface FixLoopGenerationPort {
  generate(input: FixLoopGenerateInput): Promise<FixLoopGenerateResult>;
}

export interface FixLoopExecuteInput {
  namespace: string;
  specFiles?: string[];
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
  revalidate?: (specDir: string) => Promise<{ ok: boolean; errors: string[] }>;
}


export interface FixLoopInput {
  initialRun: FixLoopRun;
  isCode: boolean;
  generating: boolean;
  mode: RunMode;
  objectiveSource: string[];
  maxRetries: number;
  cycleBudget: CycleBudget;
  wallClockBudget: WallClockBudget;
  devHealthy: () => Promise<boolean>;
  namespace: string;
  initialSpecSources?: string[];
  /* True only when this run will be measured for change-coverage — filtering a retry would then undercount passing specs. Defaults to false (never filter). */
  coverageWillMeasure?: boolean;
  failureDomSnapshot?: string;
  specDir?: string;
}

export interface FixLoopResult {
  run: FixLoopRun;
  retries: number;
  realBugDetected: boolean;
  /* Last adjudicator verdict for Issue labeling by the caller. undefined when the loop never ran. */
  lastAdjudicatorVerdict: AdjudicatorVerdict | undefined;
  coverageNamespace: string;
  /* Last regen round's specMetas at loop exit. undefined when the loop never regenerated — never fabricated. */
  lastSpecMetas: { flow?: string; objective?: string }[] | undefined;
}

const failCount = (r: FixLoopRun): number => r.cases.filter((c) => c.status === "fail").length;

/* Suite-relative spec path in one canonical form: forward slashes, no leading "./". */
function normalizeSpecPath(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

function buildFailureDomLines(failureDom: string | undefined): string[] {
  if (!failureDom) return [];
  return failureDom.split("\n").filter((l) => l.trim());
}

export class FixLoop {
  constructor(private readonly deps: FixLoopDeps) {}

  async run(input: FixLoopInput): Promise<FixLoopResult> {
    let run = input.initialRun;
    let retries = 0;
    let prevRound: RoundResult | null = null;
    let bestRunSoFar: FixLoopRun = run;
    let realBugDetected = false;
    let adjVerdict: AdjudicatorVerdict | undefined;
    let coverageNs = input.namespace;
    /* Only what a later round reads from the previous regeneration. */
    let lastRegenResult: Pick<FixLoopGenerateResult, "specSources" | "reexploreNavigations" | "specMetas"> | undefined =
      input.initialSpecSources?.length ? { specSources: input.initialSpecSources } : undefined;

    const maxRetries = input.maxRetries;

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

      const lever2Flips = prevRound ? [...prevRound.absentSelectors].filter((k) => !absentKeys.has(k)).length : 0;

      const curRound: RoundResult = {
        failingNames: new Set(failed.map((c) => c.name)),
        failingCount: failed.length,
        absentSelectors: absentKeys,
        lever2Flips,
        reexploreNavigations: lastRegenResult?.reexploreNavigations ?? 0,
      };
      const gate = decideProgress(prevRound, curRound);

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
      const evidence: AdjudicatorEvidence = {
        isCode: input.isCode,
        allUnique,
        failureDetails,
        failureClasses: failureDetails.map((detail) => classifyFailure(detail)),
        absentKeysCount: absentKeys.size,
        gateSpend: gate.spend,
        gateReason: gate.reason,
        devHealthy: devHealthyNow,
        mode: input.mode,
        objectiveSource: input.objectiveSource,
        failingFiles: failed.map((c) => c.file),
        httpStatuses: failed.map((c) => c.httpStatus),
        runtimeErrorsByCase: failed.map((c) => c.runtimeErrors ?? []),
      };
      const verdict = adjudicate(evidence);
      adjVerdict = verdict;

      if (verdict.action === ADJ_ACTION.BREAK_ISSUE) {
        if (verdict.class === ADJ_CLASS.RUNNER_INFRA || verdict.class === ADJ_CLASS.DEV_INFRA) {
          run = { verdict: "infra-error", cases: [] };
        } else {
          realBugDetected = true;
        }
      }
      /* Any break-* action ends the loop; for BREAK_NEEDS_HUMAN adjVerdict is already set — the caller labels the Issue. */
      if (verdict.action !== ADJ_ACTION.CONTINUE) break;

      prevRound = curRound;

      /* Regeneration with review:skip. Cycle/wall-clock budgets are forwarded unread (see the header). */
      const result = await this.deps.generation.generate({
        fixCases: failed,
        ...(selectorContradictions.length > 0 ? { selectorContradictions } : {}),
        ...(selectorContradictions.length > 0 && lever2.origins ? { selectorContradictionOrigins: lever2.origins } : {}),
        ...(input.failureDomSnapshot ? { domSnapshot: input.failureDomSnapshot } : {}),
        cycleBudget: input.cycleBudget,
        wallClockBudget: input.wallClockBudget,
      });
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

      if (input.isCode) {
        /* Code mode: re-run the repo's own test suite directly — this branch never calls deps.revalidate (that seam is e2e-only, below). Code-mode pre-execution compile validation lives in the pipeline's validation phase (CodeValidationStrategy), not per-retry here; a code retry's compile failure surfaces through the execute() run itself (exit-code classification). */
        const codeRun = await this.deps.execution.execute({ namespace: input.namespace });
        run = codeRun;
      } else {
        /* Fresh namespace per retry so a retry cannot collide with its own prior attempt's test data. */
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

      /* Keep the best EXECUTED run seen so far. infra-error is never "better". */
      if (run.verdict !== "infra-error") {
        bestRunSoFar = bestRound([
          { failingCount: failCount(bestRunSoFar), run: bestRunSoFar },
          { failingCount: failCount(run), run },
        ])!.run;
      }
    }

    /* Restore bestRunSoFar after the loop — skipped when the real-bug branch fired or the loop ended on infra-error. */
    if (
      !realBugDetected &&
      run.verdict !== "infra-error" &&
      failCount(bestRunSoFar) < failCount(run)
    ) {
      run = bestRunSoFar;
    }

    return {
      run,
      retries,
      realBugDetected,
      lastAdjudicatorVerdict: adjVerdict,
      coverageNamespace: coverageNs,
      lastSpecMetas: lastRegenResult?.specMetas,
    };
  }
}

export { isLikelyRealBug };
