/* CrossRepoImpactPort. No static app context — every call is per-triggerRepo. Fail-open: the use-case degrades every error to null except UntrustedGitTreeError, which it rethrows; this adapter adds no further try/catch. Port-local types are structurally identical to the domain VOs (plain assignment, no double-cast). */

import type { CrossRepoImpactPort } from "../../application/ports/cross-repo-impact.port.ts";
import type { CrossRepoImpact } from "../../domain/cross-repo-impact.ts";
import type { ServiceLink } from "../../domain/index.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { SandboxedBinaryRunner } from "../../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { ResolveCrossRepoImpactUseCase, type CrossRepoVcsRead, type MirrorRegistryLike } from "@contexts/service-topology/application/index.ts";

export interface CrossRepoImpactPortAdapterDeps {
  mirrors: MirrorRegistryLike;
  makeVcs: (repoDir: string) => CrossRepoVcsRead;
  /* Absent: only the contract-file tier matches. */
  codeGraph?: CodeGraphPort;
  runner: SandboxedBinaryRunner;
}

export class CrossRepoImpactPortAdapter implements CrossRepoImpactPort {
  private readonly useCase: ResolveCrossRepoImpactUseCase;

  constructor(deps: CrossRepoImpactPortAdapterDeps) {
    this.useCase = new ResolveCrossRepoImpactUseCase(deps.mirrors, deps.makeVcs, deps.codeGraph, deps.runner);
  }

  async resolve(triggerRepo: string, triggerSha: string, resolvedLinks: readonly ServiceLink[]): Promise<CrossRepoImpact | null> {
    return this.useCase.resolve(triggerRepo, triggerSha, resolvedLinks);
  }
}
