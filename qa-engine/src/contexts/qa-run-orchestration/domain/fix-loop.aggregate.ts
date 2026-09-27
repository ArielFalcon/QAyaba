/* FixLoop aggregate: selector check → adjudicate → regen → re-execute, with absentKeys short-circuit and a fewest-failures regression guard. CycleBudget/WallClockBudget are forwarded unread into every generate() call — this aggregate neither ticks nor inspects them, and neither does the generation adapter: CycleBudget.ceiling is telemetry-only, and WallClockBudget.exhausted() is checked directly by run-qa.use-case.ts before each regen round, not by this aggregate or the generator. break-needs-human exits without setting realBugDetected; the caller labels the Issue. Filtered-retry scopes to failing specs only when change-coverage will not measure this run. */

import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { RunMode } from "@kernel/run-mode.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { CycleBudget } from "./cycle-budget.ts";
import type { WallClockBudget } from "./wall-clock-budget.ts";
import { adjudicate, type AdjudicatorEvidence, type AdjudicatorVerdict, ADJ_CLASS, ADJ_ACTION } from "./adjudicate.service.ts";
import { decideProgress, classifyFailure, bestRound, isLikelyRealBug, type RoundResult } from "./helpers/progress-gate.ts";
import type { SpecSelectorFindings } from "./helpers/selector-check.ts";


export interface FixLoopRun {
  verdict: RunVerdict;
  cases: QaCase[];
}

export interface FixLoopGenerateInput {
  fixCases: QaCase[];
  selectorContradictions?: string[];
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
  check(specSources: string[], trees: string[][]): SpecSelectorFindings;
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
    let lastRegenResult: FixLoopGenerateResult | undefined = input.initialSpecSources?.length
      ? {
          // Stryker disable next-line ArrayDeclaration,BooleanLiteral: equivalent — only specSources, reexploreNavigations and specMetas are ever read from it
          specs: [], approved: true,
          specSources: input.initialSpecSources,
        }
      : undefined;

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
        // Stryker disable next-line StringLiteral: equivalent — the selector check only reports a non-MULTIPLE contradiction together with an absent key, which already clears allUnique
        !selectorContradictions.some((c) => c.includes("MULTIPLE"));

      /* Fresh devHealthy() at this snapshot; a separate fresh call happens before retry-execute — never shared or memoized. */
      const devHealthyNow = input.isCode ? true : await input.devHealthy();
      const evidence: AdjudicatorEvidence = {
        isCode: input.isCode,
        allUnique,
        /* A missing detail reads as "" — any placeholder text would classify the same ("other", not infra). */
        // Stryker disable next-line StringLiteral: equivalent — see above
        failureDetails: failed.map((c) => c.detail ?? ""),
        // Stryker disable next-line StringLiteral: equivalent — see above
        failureClasses: failed.map((c) => classifyFailure(c.detail ?? "")),
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

      switch (verdict.action) {
        case ADJ_ACTION.BREAK_ISSUE:
          if (verdict.class === ADJ_CLASS.RUNNER_INFRA || verdict.class === ADJ_CLASS.DEV_INFRA) {
            run = { verdict: "infra-error", cases: [] };
          } else {
            realBugDetected = true;
          }
          break;
        // Stryker disable next-line ConditionalExpression: equivalent — an empty case falls through to the same `break`
        case ADJ_ACTION.BREAK_NEEDS_HUMAN:
          /* Exits via the guard below; adjVerdict is already set — the caller labels the Issue. */
          break;
        // Stryker disable next-line ConditionalExpression: equivalent — an empty last case leaves the switch the same way
        case ADJ_ACTION.CONTINUE:
          break;
      }
      if (verdict.action !== ADJ_ACTION.CONTINUE) break; /* any break-* action */

      prevRound = curRound;

      /* Regeneration with review:skip. Cycle/wall-clock budgets are forwarded unread (see the header). */
      const result = await this.deps.generation.generate({
        fixCases: failed,
        // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — the generation adapter treats an empty list like an absent one
        ...(selectorContradictions.length > 0 ? { selectorContradictions } : {}),
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
          // Stryker disable next-line StringLiteral: unreachable — the only caller (RunQaUseCase) always passes specDir
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
          // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — with no failing file, every (non-empty) regen spec is an outsider, so regenStayedInFailedSet is already false
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
      // Stryker disable next-line ConditionalExpression: equivalent — an infra-error run ends the loop, and the restore below skips infra-error
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
      // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — bestRunSoFar already includes every executed non-infra run, ties going to the later one
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
