/* CrossRepoImpactPort. No static app context — every call is per-triggerRepo. Fail-open: the use-case never throws; this adapter adds no further try/catch. Port-local types are structurally identical to the domain VOs (plain assignment, no double-cast). */

import type { CrossRepoImpactPort, CrossRepoImpact, ServiceLink } from "../../application/ports/index.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { SandboxedBinaryRunner } from "../../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { ResolveCrossRepoImpactUseCase, type CrossRepoVcsRead, type MirrorRegistryLike } from "@contexts/service-topology/application/resolve-cross-repo-impact.use-case.ts";

export interface CrossRepoImpactPortAdapterDeps {
  mirrors: MirrorRegistryLike;
  makeVcs: (repoDir: string) => CrossRepoVcsRead;
  codeGraph: CodeGraphPort;
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
