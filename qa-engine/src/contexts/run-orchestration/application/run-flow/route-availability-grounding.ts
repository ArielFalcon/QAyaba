/*
 * What the grounding's route availability classification needs from the run: the run's base (its range start, so a 3-commit run
 * compares against `<head>~3`, not the parent), the app's declared login page, and the change's closure over the code graph (the
 * symbols its changed symbols reach, asked for only when a captured route was unavailable). The closure is complete only when the
 * walk was not cut and no symbol sits at its depth bound: below that bound every caller was followed.
 */
import { BlastRadius } from "@kernel/blast-radius.ts";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import type { ImpactBudget } from "@kernel/code/index.ts";
import type { ChangeClosure } from "@kernel/route-availability.ts";
import type { WorkspaceRunContext } from "./run-context.ts";
import type { RunState } from "./run-state.ts";

/* The closure's walk: the reader's deepest walk, and a node budget far above a change's ordinary reach. */
export const CHANGE_CLOSURE_BUDGET: ImpactBudget = { depth: 6, maxSymbols: 5000 };

export interface AvailabilityGrounding {
  baseRef?: string;
  loginPath?: string;
  changeClosure?: () => Promise<ChangeClosure | undefined>;
}

/* Where the run's change starts: its base, `commits` back from its head, or the head's parent. */
export function runBaseRef(anchor: { headSha: { toString(): string }; baseSha?: { toString(): string }; commits?: number }): string {
  return anchor.baseSha?.toString() ?? (anchor.commits !== undefined ? `${anchor.headSha.toString()}~${anchor.commits}` : `${anchor.headSha.toString()}^`);
}

export function availabilityGroundingOf(state: Readonly<RunState>, ctx: WorkspaceRunContext): AvailabilityGrounding {
  const { deps, input } = ctx;
  const loginPath = deps.authContext?.auth?.loginPath;
  const diff = state.classification.diff;
  if (diff === undefined || diff === "") return { ...(loginPath !== undefined ? { loginPath } : {}) };
  const codeGraph = deps.codeGraph;
  const repoDir = deps.codeGraphRepoDir ?? ctx.services.specRoot.mirrorDir;
  const changeClosure = codeGraph === undefined
    ? undefined
    : async (): Promise<ChangeClosure | undefined> => {
        const parser = new DiffParserService();
        const changed = BlastRadius.of(input.sha, parser.changedFiles(diff), parser.touchedLines(diff));
        const walked = await codeGraph.impactedSymbols(repoDir, changed, CHANGE_CLOSURE_BUDGET);
        if (!walked.ok) return undefined;
        const atBound = walked.value.symbols.some((symbol) => symbol.depth >= CHANGE_CLOSURE_BUDGET.depth);
        return {
          symbols: walked.value.symbols.map((symbol) => ({ file: symbol.file, symbol: symbol.symbol })),
          /* Seeds from no symbol at all may be an index that does not hold the changed files: nothing is proven unreached from them. */
          complete: !walked.value.truncated && !atBound && walked.value.seedBasis !== "none",
        };
      };
  return {
    baseRef: runBaseRef(input.changeSet.anchor),
    ...(loginPath !== undefined ? { loginPath } : {}),
    ...(changeClosure !== undefined ? { changeClosure } : {}),
  };
}
