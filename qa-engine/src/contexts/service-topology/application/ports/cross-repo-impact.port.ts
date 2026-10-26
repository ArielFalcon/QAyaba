import type { ServiceLink, CrossRepoImpact } from "@kernel/service-links.ts";

/**
 * Advisory impacted-link narrowing. Fires only on cross-repo runs
 * (triggerRepo present and a resolved link targets it). Failure degrades to null
 * and whole-link rendering falls back, except UntrustedGitTreeError (untrusted
 * code replaced the mirror's git dir), which is thrown and fails the run.
 */
export interface CrossRepoImpactPort {
  /* `baseRef` is the commit the change starts from (a sha, or `<sha>~n`); absent, the commit before `triggerSha`. */
  resolve(triggerRepo: string, triggerSha: string, resolvedLinks: readonly ServiceLink[], baseRef?: string): Promise<CrossRepoImpact | null>;
}
