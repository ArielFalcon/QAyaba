/*
 * What the grounding's route availability classification needs from the run: the run's base (its range start, so a 3-commit run
 * compares against `<head>~3`, not the parent), the app's declared login page, and the change's closure over the code graph (the
 * symbols its changed symbols reach, asked for only when a captured route was unavailable). The closure is complete only when the
 * walk was not cut and no symbol sits at its depth bound: below that bound every caller was followed.
 */
import { BlastRadius } from "@kernel/blast-radius.ts";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import { DEFAULT_WALK_POLICY, type WalkPolicy } from "@kernel/code/index.ts";
import { outcomeText, pathOnly, type ChangeClosure, type RouteAvailabilityFact } from "@kernel/route-availability.ts";
import { candidateId, type UseCaseCandidate } from "@contexts/change-analysis/application/index.ts";
import type { WorkspaceRunContext } from "./run-context.ts";
import type { RunState } from "./run-state.ts";

/* The closure's walk: the run's walk policy, deeper, so a guard several calls above a changed symbol is still reached. */
export const CHANGE_CLOSURE_POLICY: WalkPolicy = { ...DEFAULT_WALK_POLICY, depth: 6 };

export interface AvailabilityGrounding {
  baseRef?: string;
  loginPath?: string;
  changeClosure?: () => Promise<ChangeClosure | undefined>;
}

/* Where the run's change starts: its base, `commits` back from its head, or the head's parent. */
export function runBaseRef(anchor: { headSha: { toString(): string }; baseSha?: { toString(): string }; commits?: number }): string {
  return anchor.baseSha?.toString() ?? (anchor.commits !== undefined ? `${anchor.headSha.toString()}~${anchor.commits}` : `${anchor.headSha.toString()}^`);
}

/* The evidence line a route-config candidate carries: where the browser ends and why the change governs it. */
export function routeConfigEvidence(fact: RouteAvailabilityFact): string {
  const basis = fact.basis;
  const why = basis.class === "change-introduced" ? (basis.via === "route-declaration" ? `route table entry changed at ${basis.at}` : `a changed symbol reaches its guard ${basis.at}`) : basis.class;
  const session = fact.sessionAttached === true ? "with this run's session " : "";
  return `${why}; ${session}the browser ends on ${outcomeText(fact.outcome)}`;
}

/*
 * The use cases with the change's own unavailabilities made direct: a route the change governs, observed sent away by the
 * capture, is a use case to assert (`route-config`), whether or not a map link or the call graph named its page. An existing
 * candidate of the page keeps its id and gains the basis and the fact; a page no candidate named becomes one.
 */
export function withRouteConfigCandidates(candidates: readonly UseCaseCandidate[], facts: readonly RouteAvailabilityFact[], repo: string): UseCaseCandidate[] {
  const out = [...candidates];
  for (const fact of facts) {
    if (fact.basis.class !== "change-introduced") continue;
    const route = fact.template ?? fact.route;
    const evidence = routeConfigEvidence(fact);
    const at = out.findIndex((c) => c.entry.kind === "page" && pathOnly(c.entry.route) === pathOnly(route));
    if (at >= 0) {
      const held = out[at]!;
      out[at] = { ...held, tier: "direct", basis: "route-config", evidence: [evidence, ...held.evidence.filter((line) => line !== evidence)] };
      continue;
    }
    const entry = { kind: "page" as const, repo, route };
    out.push({ id: candidateId(entry), entry, tier: "direct", basis: "route-config", evidence: [evidence], seeds: [], confidence: 1, reachability: "page", pages: [], existingSpecs: [] });
  }
  return out;
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
        const walked = await codeGraph.impactedSymbols(repoDir, changed, CHANGE_CLOSURE_POLICY);
        if (!walked.ok) return undefined;
        /* A hub the walk did not expand is reached all the same: its closure (what calls it) is the rest of the change's reach. */
        const hubs = walked.value.hubNodes ?? [];
        const reached = [...walked.value.symbols, ...hubs.flatMap((hub) => hub.closure.symbols)];
        const atBound = reached.some((symbol) => symbol.depth >= CHANGE_CLOSURE_POLICY.depth);
        /* A guard is named by its class: one whose method changed is touched by the change. */
        const containers = walked.value.containers ?? [];
        return {
          symbols: [...reached, ...containers].map((symbol) => ({ file: symbol.file, symbol: symbol.symbol })),
          /* Seeds from no symbol at all may be an index that does not hold the changed files: nothing is proven unreached from them. */
          complete: !walked.value.truncated && hubs.every((hub) => hub.closure.complete) && !atBound && walked.value.seedBasis !== "none",
        };
      };
  return {
    baseRef: runBaseRef(input.changeSet.anchor),
    ...(loginPath !== undefined ? { loginPath } : {}),
    ...(changeClosure !== undefined ? { changeClosure } : {}),
  };
}
