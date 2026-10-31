/* WorkspacePort: inject checkout so tests need no real git. Cross-repo routing stays inside the injected fn (receives only the Sha). Checkout errors propagate loudly. */

import type { Sha } from "@kernel/sha.ts";
import type { WorkspaceHandle } from "../../domain/workspace-handle.ts";
import type { WorkspacePort } from "../../application/ports/workspace.port.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

export type CheckoutFn = (sha: Sha) => Promise<string>;

export interface WorkspacePortStaticContext {
  /* Tests folder relative to mirrorDir. Distinct from the run's prompt-side e2e folder name. */
  specRelDir: string;
}

export class WorkspacePortAdapter implements WorkspacePort {
  constructor(
    private readonly checkout: CheckoutFn,
    private readonly ctx: WorkspacePortStaticContext,
    private readonly registry: WorkspaceRegistry,
  ) {}

  async prepare(sha: Sha): Promise<WorkspaceHandle> {
    const mirrorDir = await this.checkout(sha);
    /* Publish stages from the mirror root (pathspecs are relative to mirrorDir, never specDir). The registry keeps the root beside the handle, so it is never derived back from specDir (lossy when specDir === mirrorDir). */
    const specDir = `${mirrorDir}/${this.ctx.specRelDir}`;
    return this.registry.register({ mirrorDir, specDir, sha: sha.toString() });
  }

  readRoots(workspace: WorkspaceHandle): { mirrorDir: string; specDir: string } {
    const { mirrorDir, specDir } = this.registry.resolve(workspace);
    return { mirrorDir, specDir };
  }
}
