/* The command-line flags every hardened git call carries, with or without a working copy. Only the two hardening modules may import this (see .dependency-cruiser.cjs, no-git-hardening-flags-outside-hardening): the flags alone are the hardening minus the working-copy verification, so an engine module holding them could run git on a sandbox-touched working copy without its git dir ever being judged. */

/** The hook, fsmonitor and bare-repository overrides. */
export function baseGitHardeningFlags(): string[] {
  return ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "safe.bareRepository=explicit"];
}
