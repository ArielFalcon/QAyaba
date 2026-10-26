import type { ServiceLink } from "../../domain/index.ts";
import type { CrossRepoImpact } from "../../domain/cross-repo-impact.ts";

/**
 * Advisory impacted-link narrowing. Fires only on cross-repo runs
 * (triggerRepo present and a resolved link targets it). Failure degrades to null
 * and whole-link rendering falls back, except UntrustedGitTreeError (untrusted
 * code replaced the mirror's git dir), which is thrown and fails the run.
 */
export interface CrossRepoImpactPort {
  resolve(triggerRepo: string, triggerSha: string, resolvedLinks: readonly ServiceLink[]): Promise<CrossRepoImpact | null>;
}
