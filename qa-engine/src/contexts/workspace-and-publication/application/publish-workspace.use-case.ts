/* Publishes a run's workspace to its branch: stage the policy's pathspecs, commit, push. Nothing changed reports `changed: false` and touches no branch. */

import { WriteConfinementService } from "../domain/write-confinement.service.ts";
import { commitMessageFor, excludesFor, pathspecsFor, type PublishKind } from "../domain/publish-policy.ts";
import type { VcsWritePort } from "./ports/vcs-write.port.ts";

export interface PublishOutcome {
  changed: boolean;
  /* Tracked-file denylist revert, forwarded so the run can merge it into its confinement signal. */
  revertedDenylisted?: string[];
  revertedDangerous?: string[];
}

export class PublishWorkspace {
  private readonly confinement = new WriteConfinementService();

  constructor(
    private readonly kind: PublishKind,
    private readonly vcs: VcsWritePort,
  ) {}

  async publish({ mirrorDir, branch }: { mirrorDir: string; branch: string; sha?: string }): Promise<PublishOutcome> {
    const pathspecs = pathspecsFor(this.kind);
    /*
     * Apply local ignore patterns FIRST so both the change check and the `git add` below silently skip
     * installed deps/artifacts instead of failing on an ignored path (the node_modules/.gitignore
     * `git add` failure this ordering fixes).
     */
    await this.vcs.writeExcludes(mirrorDir, excludesFor(this.kind));
    const changed = await this.vcs.hasChanges(mirrorDir, pathspecs);
    if (!changed) return { changed: false };
    await this.vcs.checkoutBranch(mirrorDir, branch);
    const { revertedDenylisted, revertedDangerous } = await this.vcs.commit(mirrorDir, commitMessageFor(this.kind), pathspecs, (path) => this.confinement.isCodeDenied(path));
    await this.vcs.push(mirrorDir, branch);
    return { changed: true, revertedDenylisted, revertedDangerous };
  }
}
