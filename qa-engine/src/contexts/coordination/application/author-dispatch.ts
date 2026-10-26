/*
 * How a run's own authoring reaches an author sidekick: a login still to be written, the repo's own tests, the architecture map, and
 * every regeneration of what the run has delivered. One author works in the run's working copy under the run's deadline; the flows
 * of a plan are the fan-out's. Whatever the author writes is untrusted like any sidekick's: the caller confines the working copy
 * after the turn and the run's own checks decide what stands.
 */
import type { AuthorPort, GenerationEnrichment, GenerationOutput } from "@contexts/generation/application/index.ts";
import type { RunMode } from "@kernel/run-mode.ts";
import { AUTHOR_TARGET, authorTargetSpec, type AuthorTarget } from "./sidekick-kinds.ts";

export type RunAuthorTarget = Exclude<AuthorTarget, typeof AUTHOR_TARGET.FLOW>;

/* What the run authors: the repo's own tests for a code run, the architecture map for a context run, specs otherwise. */
export function authorTargetOf(run: { isCode: boolean; mode: RunMode }): RunAuthorTarget {
  if (run.isCode) return AUTHOR_TARGET.CODE;
  return run.mode === "context" ? AUTHOR_TARGET.CONTEXT : AUTHOR_TARGET.E2E;
}

export interface AuthorRequest {
  target: RunAuthorTarget;
  specDir: string;
  signal?: AbortSignal;
  diff?: string;
  /* What the author is told: the run's grounding and, on a regeneration, the evidence and the specs delivered so far. */
  enrichment?: GenerationEnrichment;
}

/*
 * One author sidekick, on a session of its own. A run-level author is bound to no run_spec loop (a loop belongs to one flow of a
 * plan), so the prompt it is sent states no run_spec budget.
 */
export async function dispatchAuthor(author: AuthorPort, request: AuthorRequest): Promise<GenerationOutput> {
  const spec = authorTargetSpec(request.target);
  if (!spec) throw new Error(`no author target "${request.target}" is registered`);
  const { closedLoop: _unbound, ...granted } = request.enrichment ?? {};
  return author.author(request.specDir, request.signal, request.diff, granted);
}
