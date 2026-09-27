
/*
 * Local working copy of watched repos. Read-only for the agent; only the orchestrator
 * writes (and only e2e/ via PR). The app is never built or started here.
 */

import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RedactionPortAdapter } from "../orchestrator/sanitizer";
import { InfraError } from "../errors";
import { MirrorProvisionAdapter, type MirrorProvisionDeps } from "../../qa-engine/src/contexts/workspace-and-publication/infrastructure/mirror-provision.adapter";


const redactionPort = new RedactionPortAdapter();

export type Git = (args: string[], cwd?: string) => Promise<string>;

export interface MirrorDeps {
  git: Git;
  exists(path: string): boolean;
  removeFile(path: string): void;
  root?: string;
}

/* Single source for a repo's mirror directory. */
export function workdirRoot(): string {
  return process.env.MIRROR_DIR ?? join(process.cwd(), ".mirrors");
}

/*
 * The remote URL NEVER carries a credential. git persists the clone URL into the
 * mirror's .git/config, and the mirrors volume is mounted into the agent container
 * (the agent's session cwd, with bash/read tools) — a token in the URL would hand
 * the push credential to the LLM and to untrusted watched-repo lifecycle scripts.
 * Auth happens exclusively through the transient -c insteadOf rewrite (authHeaderArgs).
 */
function tokenlessUrl(repo: string): string {
  return `${gitRemoteBase()}/${repo}.git`;
}

/* The SCM host base URL (no trailing slash). GIT_REMOTE_BASE may carry a path prefix for hosts served under a sub-path (https://host/gitlab). */
export function gitRemoteBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GIT_REMOTE_BASE?.trim() || "https://github.com").replace(/\/+$/, "");
}

/* True when the remote is github.com, the only host whose REST API the GitHub integrations speak. */
export function isGithubRemote(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return new URL(gitRemoteBase(env)).hostname === "github.com";
  } catch {
    return false;
  }
}

/*
 * A commit SHA passed to git as a positional arg MUST be a hex id. A hex 7–40 string
 * can never be parsed as a git option (e.g. `--output=...`), which closes the
 * git-argument-injection surface from an attacker-controlled webhook/API sha.
 */
const HEX_SHA = /^[0-9a-f]{7,40}$/i;
export function assertHexSha(sha: string): void {
  if (!HEX_SHA.test(sha)) throw new Error(`invalid commit sha (must be 7–40 hex chars): ${JSON.stringify(sha)}`);
}

/*
 * Token-in-URL auth via -c url.insteadOf, scoped to the configured remote (GIT_REMOTE_BASE): its
 * URLs are transparently rewritten to <scheme>://<user>:<token>@<host>/… for the duration of one
 * git command — no credential helper, no token in .git/config, works on every OS. Token:
 * GIT_TOKEN, else GITHUB_TOKEN. User: GIT_TOKEN_USER, else "x-access-token" on github.com and
 * "oauth2" elsewhere (the name GitLab accepts for any access token).
 */
export function authHeaderArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const token = env.GIT_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (!token) return [];
  const base = gitRemoteBase(env);
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`GIT_REMOTE_BASE is not a valid URL: ${JSON.stringify(base)}`);
  }
  const user = env.GIT_TOKEN_USER?.trim() || (url.hostname === "github.com" ? "x-access-token" : "oauth2");
  const hostAndPath = base.slice(url.protocol.length + 2);
  return ["-c", `url.${url.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(token)}@${hostAndPath}/.insteadOf=${base}/`];
}

/*
 * Maps MirrorDeps into MirrorProvisionDeps: root via workdirRoot(), remoteUrl is tokenless,
 * and git prepends authHeaderArgs() for clone/fetch only so the adapter argv never carries a credential.
 */
function toProvisionDeps(deps: MirrorDeps): MirrorProvisionDeps {
  return {
    root: deps.root ?? workdirRoot(),
    exists: deps.exists,
    removeFile: deps.removeFile,
    remoteUrl: tokenlessUrl,
    git: (args, cwd) => (args[0] === "clone" || args[0] === "fetch" ? deps.git([...authHeaderArgs(), ...args], cwd) : deps.git(args, cwd)),
  };
}


export async function ensureMirror(repo: string, sha: string, deps: MirrorDeps): Promise<string> {
  return new MirrorProvisionAdapter(toProvisionDeps(deps)).ensureMirror(repo, sha);
}


export async function ensureMirrorAtBranch(repo: string, branch: string, deps: MirrorDeps): Promise<string> {
  return new MirrorProvisionAdapter(toProvisionDeps(deps)).ensureMirrorAtBranch(repo, branch);
}

/*
 * Diff of commit `sha` against its parent (content only, without the header).
 * A MERGE commit has 2+ parents, and `git show` emits an EMPTY diff for it by default —
 * which would blind both commit classification and change-coverage to the merge's blast
 * radius. Merging a PR into the default branch is the canonical "commit deployed to DEV"
 * event, so this case is the rule, not the exception: diff against the FIRST parent so
 * the net change the merge introduced is visible.
 */
export async function getCommitDiff(dir: string, sha: string, deps: MirrorDeps, commits = 1): Promise<string> {
  assertHexSha(sha);
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
 * AUTHORITATIVE spec set: the orchestrator trusts the working copy, never the agent's
 * self-reported list (which can name files it did not write, or omit files it did).
 * `--untracked-files=all` is REQUIRED, not cosmetic: when the whole e2e/ folder is itself
 * untracked — every FIRST run on a newly-onboarded app, where the seed was just bootstrapped
 * into a repo that has no committed e2e/ — plain `git status --porcelain` collapses it to a
 * single `?? e2e/` line and never names the .spec.ts files inside, so the agent's real specs
 * read as "0 on disk" and the run falsely returns `skipped`. `-uall` recurses into untracked
 * directories and lists each file, so the specs are seen on the first run too.
 */
export async function listChangedSpecs(dir: string, e2eRelDir: string, deps: MirrorDeps): Promise<string[]> {
  const out = await deps.git(["status", "--porcelain", "--untracked-files=all", "--", e2eRelDir], dir);
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
export async function getCommitMessage(dir: string, sha: string, deps: MirrorDeps): Promise<string> {
  assertHexSha(sha);
  return deps.git(["show", "-s", "--format=%B", sha], dir);
}

/*
 * Prepend the orchestrator's git hardening as COMMAND-LINE `-c` overrides (which a repo's own
 * .git/config cannot override) before the caller's subcommand. Two concerns, both stemming from
 * operating on UNTRUSTED, sandbox-touched working copies:
 * - core.hooksPath=/dev/null — a commit/checkout would otherwise run the repo's hooks AS THE
 * ORCHESTRATOR (root); a sandbox-planted `.git/hooks/pre-commit` is a root-RCE escape. The
 * orchestrator never relies on a repo's hooks, so disabling them is uniformly safe.
 * - safe.directory=* — after an e2e/code run the orchestrator chowns the working copy to the
 * unprivileged sandbox uid (to execute untrusted specs). git-as-root then aborts the NEXT
 * run's ops with "detected dubious ownership" (CVE-2022-24765 guard). These are the
 * orchestrator's own mirror dirs and hooks are already disabled above, so opting out of the
 * ownership check is safe and keeps the mirror reusable across privilege-dropped runs.
 * SCOPE CAVEAT: `*` is intentionally broad (this pure helper has no path context) and ALL git
 * callers go through here. That is acceptable because every current caller operates only on the
 * orchestrator's own mirror dirs under MIRROR_DIR with hooks disabled; a future caller for a
 * DIFFERENT context should scope this to a specific path (`safe.directory=<dir>`) instead.
 */
export function hardenGitArgs(args: readonly string[]): string[] {
  return ["-c", "core.hooksPath=/dev/null", "-c", "safe.directory=*", ...args];
}


function scrubGitError(err: Error & { cmd?: string }): Error {
  err.message = redactionPort.redactText(err.message);
  if (typeof err.cmd === "string") err.cmd = redactionPort.redactText(err.cmd);
  return err;
}

export const realGit: Git = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile("git", hardenGitArgs(args), { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) => {
      if (!err) {
        resolve(stdout.toString());
        return;
      }
      /*
       * A git fault is by definition an ENVIRONMENT fault (network/auth/corrupt mirror/host pressure),
       * never a code/test verdict — wrap the scrubbed error in InfraError so runner.ts's isInfraError
       * classifies it as a clean inconclusive infra-error instead of a mislabeled "unexpected internal
       * error" + maintainer incident. Scrub first so the credential redaction happens at the spawn
       * boundary before ANY error instance escapes.
       */
      const scrubbed = scrubGitError(err);
      reject(new InfraError(scrubbed.message, { cause: scrubbed }));
    });
  });

export const defaultMirrorDeps: MirrorDeps = {
  git: realGit,
  exists: existsSync,
  removeFile: (path) => rmSync(path, { force: true }),
};

/*
 * Resolves a symbolic ref (branch/tag) to a concrete SHA via git ls-remote.
 * Auth flows through the -c insteadOf rewrite: the rewritten URL carries inline
 * credentials, so no credential helper is consulted (no terminal → no prompt) and
 * the URL argument itself stays tokenless.
 */
export async function resolveRef(repo: string, ref: string, deps: MirrorDeps): Promise<string> {
  const stdout = await deps.git([...authHeaderArgs(), "ls-remote", tokenlessUrl(repo), ref]);
  const sha = stdout.split(/\s/)[0];
  if (!sha || sha.length < 40) throw new Error(`no SHA resolved for ${ref}`);
  return sha;
}

/*
 * Host-agnostic repository lookup: `git ls-remote --symref <url> HEAD` both proves read access
 * (same credential path as clone) and names the default branch. Used where the GitHub REST API
 * does not apply (any non-github.com remote, e.g. GitLab). Visibility and description are not
 * observable through git, so the repo is reported private with no description.
 */
export async function getRepoInfoViaGit(repo: string, deps: MirrorDeps): Promise<RepoInfoViaGit> {
  const stdout = await deps.git([...authHeaderArgs(), "ls-remote", "--symref", tokenlessUrl(repo), "HEAD"]);
  const head = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(stdout);
  if (!head) throw new Error(`could not resolve the default branch of ${repo} (empty repository or no HEAD)`);
  return { name: repo.split("/").pop() ?? repo, fullName: repo, private: true, defaultBranch: head[1]!, description: null };
}

export interface RepoInfoViaGit {
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
}

/*
 * How many commits is `headSha` ahead of `fromSha`? Returns 0 when fromSha is not
 * an ancestor (history diverged) or when the SHAs are equal. Used by staleness
 * detection for the context map.
 */
export async function getCommitsBehind(
  mirrorDir: string,
  fromSha: string,
  headSha: string,
  deps: MirrorDeps,
): Promise<number> {
  /*
   * Both SHAs are interpolated into a git revspec (`fromSha..headSha`). assertHexSha
   * guarantees they cannot be parsed as git options — closing the same injection surface
   * the rest of this module defends (the context map's builtAtSha is repo-controlled).
   */
  assertHexSha(fromSha);
  assertHexSha(headSha);
  /*
   * Do NOT swallow a git error into 0: an orphaned/force-pushed fromSha makes `rev-list`
   * fail, and reporting "0 behind" would silently claim the map is fresh. Let it throw so
   * the caller can warn "could not verify" (fail-loud) instead of pretending freshness.
   */
  const stdout = await deps.git(["rev-list", "--count", `${fromSha}..${headSha}`], mirrorDir);
  const n = parseInt(stdout.trim(), 10);
  if (!Number.isFinite(n)) throw new Error(`unexpected rev-list output: ${JSON.stringify(stdout.trim().slice(0, 40))}`);
  return n;
}


export async function getChangedFilesInRange(
  mirrorDir: string,
  baseSha: string,
  headSha: string,
  deps: MirrorDeps,
): Promise<string[]> {
  assertHexSha(baseSha);
  assertHexSha(headSha);
  /*
   * When baseSha === headSha (single-commit / degenerate PR), return immediately to
   * avoid `git diff --name-only sha..sha` producing an empty output (correct, but the
   * caller already has the changed files from the commit diff).
   */
  if (baseSha === headSha) return [];
  /* --name-only lists only the file paths changed between base and head, one per line. */
  const stdout = await deps.git(["diff", "--name-only", `${baseSha}..${headSha}`], mirrorDir);
  const files = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  /* Deduplicate and sort for determinism (renames can appear twice under both paths). */
  return [...new Set(files)].sort();
}

/*
 * Full unified diff across a commit RANGE (base..head) — the union of everything a PR
 * introduced, not just its tip. Twin of getChangedFilesInRange, but returns the diff WITH
 * line content so parseDiffHunks derives both changed files AND changed lines. Single-commit
 * callers keep using getCommitDiff; this is only taken when a base SHA is known (PR/push range).
 */
export async function getRangeDiff(
  dir: string,
  baseSha: string,
  headSha: string,
  deps: MirrorDeps,
): Promise<string> {
  assertHexSha(baseSha);
  assertHexSha(headSha);
  return deps.git(["diff", `${baseSha}..${headSha}`], dir);
}
