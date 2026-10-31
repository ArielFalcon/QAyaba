/* This context is the only holder of VcsWritePort — the agent-read-only security seam. RedactionPort is consumed from the kernel, not redefined here. */

export interface VcsWritePort {
  /**
   * Optional denyModifiedTracked is a second, independent guard against a modified-tracked denylisted path reaching the commit (gitignore-style excludes only suppress untracked paths). Independent of WriteConfinementAdapter.enforce() (RunQaUseCase fail-opens that call). Always returns arrays, never undefined. revertedDangerous is the secret-tier subset (env files or a symlink escape), computed HERE via WriteConfinementService — a caller must never re-implement that check or conflate reverted with dangerous.
   */
  commit(dir: string, message: string, files: readonly string[], denyModifiedTracked?: (path: string) => boolean): Promise<{ revertedDenylisted: string[]; revertedDangerous: string[] }>;
  push(dir: string, branch: string): Promise<void>;
  checkoutBranch(dir: string, branch: string): Promise<void>;
  hasChanges(dir: string, pathspecs: readonly string[]): Promise<boolean>;
  /** Writes gitignore-style patterns to .git/info/exclude (LOCAL, never committed) so `git add` on a directory pathspec silently skips installed deps/artifacts instead of failing on an ignored path. */
  writeExcludes(dir: string, patterns: readonly string[]): Promise<void>;
}
