/* ConfinementPort over the path-based write-confinement collaborator: the mirror root and the target come from the run's handle, never from the caller. */

import type { ConfinementPort, ConfinementResult, WorkspaceHandle } from "@contexts/run-orchestration/application/index.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

/* Structural mirror of WriteConfinementAdapter.enforce (infrastructure/write-confinement.adapter.ts) — duck-typed, the shell supplies the real one. */
export interface PathConfinementCollaborator {
  enforce(mirrorDir: string, isCode: boolean, signal?: AbortSignal): Promise<ConfinementResult>;
}

export class ConfinementPortAdapter implements ConfinementPort {
  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly inner: PathConfinementCollaborator,
  ) {}

  async enforce(workspace: WorkspaceHandle, signal?: AbortSignal): Promise<ConfinementResult> {
    const { mirrorDir, isCode } = this.registry.resolve(workspace);
    return await this.inner.enforce(mirrorDir, isCode, signal);
  }
}
