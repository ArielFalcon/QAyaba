/*
 * Resolves the per-run working copy and stages every declared sibling service's READ-ONLY
 * context into it. Same-repo: ensureMirror the primary at the event sha. Cross-repo (a webhook
 * from a declared service): ensureMirror the SERVICE at the event sha (the diff/classify source),
 * ensureMirrorAtBranch the PRIMARY at baseBranch HEAD (the suite workspace), stage the triggering
 * service's own sha-scoped context, then stage every OTHER declared service contracts-only.
 *
 * Declared-service mirrors are ensured CONCURRENTLY — none depends on another's result. When one
 * fails, checkout still waits for every sibling to settle before rethrowing the first failure (in
 * declared order), so no sibling keeps writing into the working copy after the run has moved on.
 *
 * Code target: sibling (contracts-only) staging is skipped — the generator writes source-level
 * tests, not FE<->BE mapped e2e specs, and has no use for sibling contracts. A service-triggered
 * code run still stages the TRIGGERING service's sha-scoped change context: the generation prompt
 * points at that directory to show what changed, and code publish excludes
 * e2e/.qa/service-context/ so it is never committed.
 */

import type { Sha } from "@kernel/sha.ts";

export interface DeclaredService {
  repo: string;
  baseBranch?: string;
  openapi?: string | string[];
}

export interface StagedServiceRef {
  repo: string;
  mirrorDir: string;
  openapi?: string | string[];
}

export interface ServiceStageInput {
  workingCopyDir: string;
  service: StagedServiceRef;
  sha?: string;
}

export interface MultiRepoCheckoutDeps {
  /** Mirror ops are pre-curried by the composition root (e.g. deps baked in) — 2-arg here on purpose. */
  ensureMirror(repo: string, sha: string): Promise<string>;
  ensureMirrorAtBranch(repo: string, branch: string): Promise<string>;
  stageServiceContext(input: ServiceStageInput): Promise<unknown>;
}

export interface MultiRepoCheckoutStaticContext {
  primaryRepo: string;
  baseBranch: string;
  services: DeclaredService[];
  triggerService?: { repo: string; openapi?: string | string[] };
  /** A code-target run never stages declared services (see module header). */
  isCode: boolean;
}

export class MultiRepoCheckoutAdapter {
  constructor(
    private readonly ctx: MultiRepoCheckoutStaticContext,
    private readonly deps: MultiRepoCheckoutDeps,
  ) {}

  private async stageDeclaredServices(primaryDir: string, skipRepo?: string): Promise<void> {
    if (this.ctx.isCode || this.ctx.services.length === 0) return;
    const targets = this.ctx.services.filter((svc) => !(skipRepo && svc.repo === skipRepo));
    const settled = await Promise.allSettled(
      targets.map(async (svc) => {
        const svcDir = await this.deps.ensureMirrorAtBranch(svc.repo, svc.baseBranch ?? "main");
        await this.deps.stageServiceContext({
          workingCopyDir: primaryDir,
          service: { repo: svc.repo, mirrorDir: svcDir, ...(svc.openapi ? { openapi: svc.openapi } : {}) },
        });
      }),
    );
    const firstFailure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (firstFailure) throw firstFailure.reason;
  }

  async checkout(checkoutSha: Sha): Promise<string> {
    if (this.ctx.triggerService) {
      const serviceMirrorDir = await this.deps.ensureMirror(this.ctx.triggerService.repo, checkoutSha.value);
      const primaryDir = await this.deps.ensureMirrorAtBranch(this.ctx.primaryRepo, this.ctx.baseBranch);
      await this.deps.stageServiceContext({
        workingCopyDir: primaryDir,
        service: {
          repo: this.ctx.triggerService.repo,
          mirrorDir: serviceMirrorDir,
          ...(this.ctx.triggerService.openapi ? { openapi: this.ctx.triggerService.openapi } : {}),
        },
        sha: checkoutSha.value,
      });
      await this.stageDeclaredServices(primaryDir, this.ctx.triggerService.repo);
      return primaryDir;
    }
    const primaryDir = await this.deps.ensureMirror(this.ctx.primaryRepo, checkoutSha.value);
    await this.stageDeclaredServices(primaryDir);
    return primaryDir;
  }
}
