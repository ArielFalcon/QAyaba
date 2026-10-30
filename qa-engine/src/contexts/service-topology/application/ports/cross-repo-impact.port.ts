import type { ServiceLink, CrossRepoImpact } from "@kernel/service-links.ts";
import type { DownstreamHopRequest, DownstreamRequest, HopResult, UpstreamHopRequest } from "../resolve-cross-repo-impact.use-case.ts";

/**
 * Advisory impacted-link narrowing. Fires only on cross-repo runs
 * (triggerRepo present and a resolved link targets it). Failure degrades to null
 * and whole-link rendering falls back, except UntrustedGitTreeError (untrusted
 * code replaced the mirror's git dir), which is thrown and fails the run.
 */
export interface CrossRepoImpactPort {
  /* `baseRef` is the commit the change starts from (a sha, or `<sha>~n`); absent, the commit before `triggerSha`. */
  resolve(triggerRepo: string, triggerSha: string, resolvedLinks: readonly ServiceLink[], baseRef?: string): Promise<CrossRepoImpact | null>;
  /**
   * One later hop upstream through a repo whose index the caller has built (RFC-0011). Absent: the port answers the first hop only.
   * A hop that cannot be walked is a stop in the answer, never a throw, except for an untrusted git dir.
   */
  resolveUpstreamHop?(request: UpstreamHopRequest): Promise<HopResult>;
  /** The links out of a changed repo that its change reaches, and the links beyond them, hop by hop (RFC-0011). Absent: nothing is read downstream. Grounding only. */
  resolveDownstream?(request: DownstreamRequest): Promise<HopResult>;
  resolveDownstreamHop?(request: DownstreamHopRequest): Promise<HopResult>;
}
