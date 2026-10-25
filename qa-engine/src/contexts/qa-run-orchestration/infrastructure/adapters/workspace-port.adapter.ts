/* WorkspacePort: inject checkout so tests need no real git. Cross-repo routing stays inside the injected fn (receives only the Sha). Checkout errors propagate loudly.
specRelDir: "e2e" for e2e; empty string for code so specDir is the bare mirrorDir (never mirrorDir/). */

import type { Sha } from "@kernel/sha.ts";
import type { WorkspacePort } from "../../application/ports/index.ts";

export type CheckoutFn = (sha: Sha) => Promise<string>;

export interface WorkspacePortStaticContext {
  /* Tests folder relative to mirrorDir. Empty composes specDir to the bare mirrorDir (code target). Distinct from CompositionConfig.e2eRelDir (prompt-side e2e folder name). */
  specRelDir: string;
}

export class WorkspacePortAdapter implements WorkspacePort {
  constructor(
    private readonly checkout: CheckoutFn,
    private readonly ctx: WorkspacePortStaticContext,
  ) {}

  async prepare(sha: Sha): Promise<{ specDir: string; mirrorDir: string }> {
    const mirrorDir = await this.checkout(sha);
    /* Publish stages from the mirror root (pathspecs are relative to mirrorDir, never specDir). Returning mirrorDir avoids deriving it back from specDir (lossy when specDir === mirrorDir). */
    return { specDir: this.ctx.specRelDir ? `${mirrorDir}/${this.ctx.specRelDir}` : mirrorDir, mirrorDir };
  }
}
