/* Advisory only: the graph complements runtime change-coverage, it never gates a PR. `repoDir` names a repo by its mirror; the adapter answers from the index the run built of that repo at the run's commit, never from the mirror itself. Every answer is repo-relative, sorted and de-duplicated, so a prompt section built from it hashes the same for the same inputs. */

import type { Result } from "@kernel/result.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { CodeGraphIndexRecord, CodeGraphUnavailable, GraphRoute, ImpactBudget, ImpactReport, ImportersReport, LocalSymbolRef } from "@kernel/code/index.ts";

export interface CodeGraphPort {
  /** Builds or refreshes the run's index of the repo at `sha`. Never throws: a failure is a record with outcome `failed` or `timeout`, and the queries then answer unavailable. The run's abort signal, when given, ends the engine's processes, this build's and those of the run's later queries. */
  syncTo(repoDir: string, sha: string, signal?: AbortSignal): Promise<CodeGraphIndexRecord>;

  /** The changed symbols (the innermost symbol around each touched line; every top-level symbol of a changed file only when the diff was not read) at depth 0, and the symbols that reach them, walked inbound within the budget. */
  impactedSymbols(repoDir: string, changed: BlastRadius, budget: ImpactBudget): Promise<Result<ImpactReport, CodeGraphUnavailable>>;

  /** The symbols that reach the named ones (depth 0), walked inbound within the budget. A name the index does not hold is absent from the answer. */
  callersOf(repoDir: string, symbols: readonly LocalSymbolRef[], budget: ImpactBudget): Promise<Result<ImpactReport, CodeGraphUnavailable>>;

  /** The routes the engine recognised, test files excluded. */
  routes(repoDir: string): Promise<Result<GraphRoute[], CodeGraphUnavailable>>;

  /** The files that import each named file, test files included. Absent on a port whose index holds no import edges: a consumer then proves nothing from imports. */
  importersOf?(repoDir: string, files: readonly string[]): Promise<Result<ImportersReport, CodeGraphUnavailable>>;
}
