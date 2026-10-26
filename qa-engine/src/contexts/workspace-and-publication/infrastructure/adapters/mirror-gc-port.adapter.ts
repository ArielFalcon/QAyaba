/* MirrorGcPort over the path-based gc collaborator: the mirror root comes from the run's handle, never from the caller. */

import type { MirrorGcPort, WorkspaceHandle } from "@contexts/run-orchestration/application/index.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

/* Structural mirror of MirrorGcAdapter.prune (infrastructure/mirror-gc.adapter.ts) — duck-typed, the shell supplies the real one. */
export interface PathMirrorGcCollaborator {
  prune(mirrorDir: string): Promise<void>;
}

export class MirrorGcPortAdapter implements MirrorGcPort {
  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly inner: PathMirrorGcCollaborator,
  ) {}

  async prune(workspace: WorkspaceHandle): Promise<void> {
    await this.inner.prune(this.registry.resolve(workspace).mirrorDir);
  }
}
