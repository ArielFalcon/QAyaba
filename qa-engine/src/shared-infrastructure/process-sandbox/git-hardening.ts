/* Git hardening for every git call the engine makes on an untrusted, sandbox-touched working copy. Twin of hardenGitArgs in src/integrations/repo-mirror.ts (qa-engine must not import src/); repo-mirror.test.ts keeps both in lockstep. */

/**
 * Prepend the hardening as COMMAND-LINE `-c` overrides, which a repo's own .git/config cannot override.
 * - core.hooksPath=/dev/null — a hook planted by the sandbox would otherwise run as the orchestrator.
 * - safe.directory=* — a code/e2e run hands the working copy to the unprivileged sandbox uid; git run
 *   as the orchestrator then rejects the tree ("dubious ownership") on the next run and the diff read
 *   fails. These are the orchestrator's own mirror dirs with hooks disabled, so opting out of the
 *   ownership check is safe.
 */
export function hardenGitArgs(args: readonly string[]): string[] {
  return ["-c", "core.hooksPath=/dev/null", "-c", "safe.directory=*", ...args];
}
