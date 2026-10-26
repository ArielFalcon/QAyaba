import type { Sha } from "@kernel/sha.ts";

export interface WorkspacePort {
  /**
   * `mirrorDir` is the working-copy root before specRelDir is joined. The "pr"
   * route needs the mirror root, not the target-aware specDir.
   */
  prepare(sha: Sha): Promise<{ specDir: string; mirrorDir: string }>;
}
