import type { ChangeRole } from "@kernel/change-set.ts";
import type { CrossRepoImpact } from "@kernel/service-links.ts";
import type { ChangeScope } from "../../domain/change-scope.ts";
import type { UseCaseCandidate } from "../../domain/use-case-candidate.ts";

/* One repo of the run's change, as the run read it: where its mirror is and what the change touched there. */
export interface ChangeScopeRepo {
  repo: string;
  role: ChangeRole;
  /* The mirror the run's index of this repo was built from. */
  repoDir: string;
  headSha: string;
  changedFiles: readonly string[];
  touchedLines?: ReadonlyMap<string, ReadonlySet<number>>;
}

export interface ChangeScopeRequest {
  /* The suite's directory: the app's context map, when one fits the run, is read from here as enrichment. */
  specDir: string;
  repos: readonly ChangeScopeRepo[];
  /* The app's own repo, whose pages a service change reaches through the call sites of its contract links; used when the change holds no entry of it. */
  pages?: { repo: string; repoDir: string };
  crossRepoImpact?: CrossRepoImpact | null;
}

/**
 * The reach of the run's change over its call graph: the entry points (pages and operations) the changed symbols of every repo
 * reach, each with its tier and evidence. Never throws: a repo whose index does not answer is a `degraded` entry of the scope,
 * and its absence from `reach` proves nothing.
 */
export interface ChangeScopePort {
  resolve(request: ChangeScopeRequest): Promise<ChangeScope>;
  /**
   * The use-case candidates of a scope: its reach made testable, in the order they are offered. The context map, the suite's
   * manifest and the suite's files enrich them; none is required and a read that fails leaves the candidates without it.
   */
  candidates(request: { specDir: string; scope: ChangeScope }): Promise<UseCaseCandidate[]>;
}
