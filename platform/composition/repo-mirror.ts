
/*
 * Local working copy of watched repos. Read-only for the agent; only the orchestrator
 * writes (and only e2e/ via PR). The app is never built or started here.
 */

import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RedactionPortAdapter } from "../telemetry/sanitizer";
import { InfraError } from "@kernel/domain-error";
/* A ref handed to git as a positional argument is judged by @kernel/git-revision first: a value that passes can never be read as an option (`--output=...`). */
import { assertRefName } from "@kernel/git-revision";
import { MirrorProvisionAdapter, type MirrorProvisionDeps } from "../../engine/src/contexts/workspace-and-publication/infrastructure/mirror-provision.adapter";
import { hardenGitArgs } from "../../engine/src/shared-infrastructure/process-sandbox/git-hardening";
import { hardenDetachedGitArgs } from "../../engine/src/shared-infrastructure/process-sandbox/detached-git-hardening";
import { activeEnvironment } from "../settings/active";
import { activeSettings } from "../settings/store";

/* The orchestrator's git hardening has one definition, in the engine (which cannot import platform/); every git caller on a working copy goes through it. */
export { hardenGitArgs, assertTrustedGitTree, UntrustedGitTreeError } from "../../engine/src/shared-infrastructure/process-sandbox/git-hardening";
/* The one variant with no working copy to verify (a clone, an ls-remote): the shell owns such calls, the engine may not import it. */
export { hardenDetachedGitArgs } from "../../engine/src/shared-infrastructure/process-sandbox/detached-git-hardening";


const redactionPort = new RedactionPortAdapter();

export type Git = (args: string[], cwd?: string) => Promise<string>;

export interface MirrorDeps {
  git: Git;
  exists(path: string): boolean;
  removeFile(path: string): void;
  /** Deletes a directory tree without following a link inside it: how a mirror the git hardening refuses is recovered. */
  removeTree?(path: string): void;
  root?: string;
}

/* Single source for a repo's mirror directory. */
export function workdirRoot(): string {
  return activeSettings().git.mirrorDir ?? join(process.cwd(), ".mirrors");
}

/*
 * The remote URL NEVER carries a credential. git persists the clone URL into the
 * mirror's .git/config, and the mirrors volume is mounted into the agent container
 * (the agent's session cwd, with bash/read tools) — a token in the URL would hand
 * the push credential to the LLM and to untrusted watched-repo lifecycle scripts.
 * Auth happens exclusively through the transient -c insteadOf rewrite (authHeaderArgs).
 */
function tokenlessUrl(repo: string): string {
  const base = activeSettings().git.remoteBase;
  return `${base}/${repo}.git`;
}

/*
 * Token-in-URL auth via -c url.insteadOf. When GITHUB_TOKEN is set, all https://github.com
 * URLs are transparently rewritten to https://x-access-token:TOKEN@github.com — no credential
 * helper involved, no token in .git/config, works on every OS.
 */
export function authHeaderArgs(): string[] {
  const token = activeEnvironment().GITHUB_TOKEN;
  return token
    ? ["-c", `url.https://x-access-token:${token}@github.com/.insteadOf=https://github.com/`]
    : [];
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
    ...(deps.removeTree ? { removeTree: deps.removeTree } : {}),
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
 * The mirror's checked-out HEAD sha, through the injected git dependency — never a direct
 * execFileSync shell-out. Going through `deps.git` gets every caller the same hardening
 * (hardenGitArgs, GIT_TERMINAL_PROMPT=0) and the same InfraError classification + credential
 * scrubbing every other git op in this module gets (see realGit above); a raw execFileSync
 * bypasses all three and reports a raw error to whatever calls it.
 */
export async function getHeadSha(dir: string, deps: MirrorDeps): Promise<string> {
  return (await deps.git(["rev-parse", "HEAD"], dir)).trim();
}

function scrubGitError(err: Error & { cmd?: string }): Error {
  err.message = redactionPort.redactText(err.message);
  if (typeof err.cmd === "string") err.cmd = redactionPort.redactText(err.cmd);
  return err;
}

/*
 * The git commands with no working copy to run in yet: the clone that creates one and the ls-remote that asks a remote.
 * Any other command called without a working copy would silently get the hardening that verifies nothing and run in the
 * process's own directory, so it is refused instead.
 */
const WORKING_COPY_FREE_COMMANDS: ReadonlySet<string> = new Set(["clone", "ls-remote"]);

function hardenedArgsFor(args: string[], cwd: string | undefined): string[] {
  if (cwd !== undefined) return hardenGitArgs(args, cwd);
  let i = 0;
  while (args[i] === "-c") i += 2; /* leading `-c key=value` pairs (auth, protocol) precede the command */
  const command = args[i];
  if (command === undefined || !WORKING_COPY_FREE_COMMANDS.has(command)) {
    throw new TypeError(`git ${command ?? "(no command)"} runs in a working copy: name it instead of running it unverified`);
  }
  return hardenDetachedGitArgs(args);
}

export const realGit: Git = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile("git", hardenedArgsFor(args, cwd), { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...activeEnvironment(), GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) => {
      if (!err) {
        resolve(stdout.toString());
        return;
      }
      /*
       * A git fault is by definition an ENVIRONMENT fault (network/auth/corrupt mirror/host pressure),
       * never a code/test verdict — wrap the scrubbed error in InfraError so runner.ts's isInfraError
       * classifies it as a clean inconclusive infra-error instead of a mislabeled "unexpected internal
       * error". Scrub first so the credential redaction happens at the spawn
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
  /* rmSync deletes a link inside the tree (or the tree's own path being one) as the link, never what it points to. */
  removeTree: (path) => rmSync(path, { recursive: true, force: true }),
};

/*
 * Resolves a symbolic ref (branch/tag) to a concrete SHA via git ls-remote.
 * Auth flows through the -c insteadOf rewrite: the rewritten URL carries inline
 * credentials, so no credential helper is consulted (no terminal → no prompt) and
 * the URL argument itself stays tokenless.
 *
 * ls-remote matches its pattern against the tail of every ref name (`main` lists `refs/heads/main` and
 * `refs/heads/feature/main`), so the answer is the line whose ref name is exactly one git's own rules make of the name
 * asked for: a branch, then a tag (a branch wins over a tag of the same name), then the full name the caller gave, then
 * the name under `refs/` (`heads/main`, `pull/1/head`) and under `refs/remotes/` (`origin/main`).
 */
export async function resolveRef(repo: string, ref: string, deps: MirrorDeps): Promise<string> {
  /* ls-remote reads the argument after the URL as a pattern, never an option; a ref from an API payload or an app's config is still judged first as defence in depth. */
  assertRefName(ref);
  const stdout = await deps.git([...authHeaderArgs(), "ls-remote", tokenlessUrl(repo), ref]);
  const shaByName = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const [sha, name] = line.split("\t");
    if (sha && name) shaByName.set(name, sha);
  }
  for (const name of [`refs/heads/${ref}`, `refs/tags/${ref}`, ref, `refs/${ref}`, `refs/remotes/${ref}`, `refs/remotes/${ref}/HEAD`]) {
    const sha = shaByName.get(name);
    if (sha && sha.length >= 40) return sha;
  }
  throw new Error(`no SHA resolved for ${ref}`);
}

