/* Git hardening for the few git calls that have no working copy to verify: a clone or an ls-remote runs before any working copy exists. A separate module so the arch gate can keep the engine off it (see .dependency-cruiser.cjs, no-detached-git-hardening-in-engine): every git call the engine makes on a working copy goes through hardenGitArgs, which verifies the git dir first, and only the shell imports this. */

import { baseGitHardeningFlags } from "./git-hardening-flags.ts";

/** Hardened argv for a git call with no working copy yet: the hook, fsmonitor and bare-repository overrides, and nothing to verify or point git at. */
export function hardenDetachedGitArgs(args: readonly string[]): string[] {
  return [...baseGitHardeningFlags(), ...args];
}
