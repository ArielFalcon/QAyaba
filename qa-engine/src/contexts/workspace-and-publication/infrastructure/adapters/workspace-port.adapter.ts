/* WorkspacePort: inject checkout so tests need no real git. Cross-repo routing stays inside the injected fn (receives only the Sha). Checkout errors propagate loudly.
specRelDir: "e2e" for e2e; empty string for code so specDir is the bare mirrorDir (never mirrorDir/). */

import type { Sha } from "@kernel/sha.ts";
import type { WorkspaceHandle } from "../../domain/workspace-handle.ts";
import type { WorkspacePort } from "../../application/ports/workspace.port.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

export type CheckoutFn = (sha: Sha) => Promise<string>;

export interface WorkspacePortStaticContext {
  /* Tests folder relative to mirrorDir. Empty composes specDir to the bare mirrorDir (code target). Distinct from the run's prompt-side e2e folder name. */
  specRelDir: string;
  /* The run's target: code runs commit the bare mirror, e2e runs the tests folder. */
  isCode: boolean;
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
    const specDir = this.ctx.specRelDir ? `${mirrorDir}/${this.ctx.specRelDir}` : mirrorDir;
    return this.registry.register({ mirrorDir, specDir, sha: sha.toString(), isCode: this.ctx.isCode });
  }

  readRoots(workspace: WorkspaceHandle): { mirrorDir: string; specDir: string } {
    const { mirrorDir, specDir } = this.registry.resolve(workspace);
    return { mirrorDir, specDir };
  }
}
