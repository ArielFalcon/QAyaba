/*
 * The three git reads of the plain-agent baseline (`scripts/baseline-agent.ts`): the diff and the message of the commit under
 * test, and the spec files the agent left in its throwaway copy. No run of the engine calls them, so they live beside their
 * only caller instead of inside the mirror module every run uses; the engine's own reads are `GitMirrorReadAdapter`'s.
 */

import { assertCommitSha } from "@kernel/git-revision.ts";
import { literalPathspecs } from "../engine/src/shared-infrastructure/process-sandbox/git-hardening.ts";

/** The git runner these reads need; a `MirrorDeps` satisfies it. */
export interface BaselineGit {
  git(args: string[], cwd?: string): Promise<string>;
}

/*
 * Diff of commit `sha` against its parent (content only, without the header).
 * A MERGE commit has 2+ parents, and `git show` emits an EMPTY diff for it by default —
 * which would blind both commit classification and change-coverage to the merge's blast
 * radius. Merging a PR into the default branch is the canonical "commit deployed to DEV"
 * event, so this case is the rule, not the exception: diff against the FIRST parent so
 * the net change the merge introduced is visible.
 */
export async function getCommitDiff(dir: string, sha: string, deps: BaselineGit, commits = 1): Promise<string> {
  assertCommitSha(sha);
  /*
   * Multi-commit window: the cumulative diff of the last `commits` commits ending at sha
   * (sha~N..sha) — analyze a short series as one blast radius instead of just the tip.
   */
  if (commits > 1) {
    return deps.git(["diff", `${sha}~${commits}`, sha], dir);
  }
  const parents = (await deps.git(["show", "-s", "--format=%P", sha], dir)).trim().split(/\s+/).filter(Boolean);
  if (parents.length > 1) {
    return deps.git(["show", "--format=", "-m", "--first-parent", sha], dir);
  }
  return deps.git(["show", "--format=", sha], dir);
}

/*
 * The *.spec.ts files the agent actually wrote/modified this run, derived from `git
 * status` over e2eRelDir (added, modified, untracked). Returned e2e-relative (e.g.
 * "flows/login.spec.ts"), excluding the seed `cleanup.spec.ts`. This is the
 * AUTHORITATIVE spec set: the baseline trusts the working copy, never the agent's
 * self-reported list (which can name files it did not write, or omit files it did).
 * `--untracked-files=all` is REQUIRED, not cosmetic: when the whole e2e/ folder is itself
 * untracked — every FIRST run on a newly-onboarded app, where the seed was just bootstrapped
 * into a repo that has no committed e2e/ — plain `git status --porcelain` collapses it to a
 * single `?? e2e/` line and never names the .spec.ts files inside, so the agent's real specs
 * read as "0 on disk" and the run falsely returns `skipped`. `-uall` recurses into untracked
 * directories and lists each file, so the specs are seen on the first run too.
 */
export async function listChangedSpecs(dir: string, e2eRelDir: string, deps: BaselineGit): Promise<string[]> {
  const out = await deps.git(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=dirty", "--", ...literalPathspecs([e2eRelDir])], dir);
  return out
    .split("\n")
    .filter((l) => l.length > 3)  /* "XY path" — 2 status chars + a space + the path */
    .map((l) => l.slice(3))
    .map((p) => {
      const i = p.indexOf(" -> ");  /* a rename reports "old -> new"; take the new path */
      return i >= 0 ? p.slice(i + 4) : p;
    })
    .filter((p) => p.endsWith(".spec.ts") && !p.endsWith("cleanup.spec.ts"))
    .map((p) => (p.startsWith(e2eRelDir + "/") ? p.slice(e2eRelDir.length + 1) : p));
}

/* Commit message (subject + body): provides the INTENT used to classify the change. */
export async function getCommitMessage(dir: string, sha: string, deps: BaselineGit): Promise<string> {
  assertCommitSha(sha);
  return deps.git(["show", "-s", "--format=%B", sha], dir);
}
