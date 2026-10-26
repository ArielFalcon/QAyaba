import { Sha } from "@kernel/sha.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import type { SandboxedBinaryRunner } from "../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { hardenGitArgs } from "../../../shared-infrastructure/process-sandbox/git-hardening.ts";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import type { VcsReadPort } from "../application/ports/vcs-read.port.ts";

/* The largest file `fileAt` returns: a contract file is far smaller; more is not one. */
export const MAX_FILE_AT_CHARS = 5 * 1024 * 1024;

/** Typed read side over a git mirror. Argv lives here; callers pass Sha and receive typed results. Read-only: this adapter never runs a git write (writes live only in workspace-and-publication). */
export class GitMirrorReadAdapter implements VcsReadPort {
  private readonly parser = new DiffParserService();
  constructor(private readonly repoDir: string, private readonly runner: SandboxedBinaryRunner) {}

  async diff(sha: Sha, opts?: { baseSha?: Sha; commits?: number }): Promise<string> {
    /* Two discrete ref args so tests can assert delegation without parsing a combined range string. */
    const baseRef = opts?.baseSha ? opts.baseSha.value
      : opts?.commits ? `${sha.value}~${opts.commits}`
      : `${sha.value}^`;
    const r = await this.runner.run({
      command: "git",
      args: hardenGitArgs(["-c", "core.quotepath=false", "diff", "--no-color", baseRef, sha.value], this.repoDir),
      cwd: this.repoDir,
      env: scrubEnv(),
    });
    /* Throw on VCS error — a non-zero exit or timeout must not become an empty diff ("no changed files"). */
    if (r.timedOut) throw new Error(`git diff timed out for ${baseRef}..${sha.value}`);
    if (r.exitCode !== 0) throw new Error(`git diff failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    return r.stdout;
  }

  /* The commit the working copy is checked out at; null when git cannot name one. */
  async headSha(): Promise<string | null> {
    const r = await this.runner.run({ command: "git", args: hardenGitArgs(["rev-parse", "--verify", "HEAD^{commit}"], this.repoDir), cwd: this.repoDir, env: scrubEnv() });
    const sha = r.stdout.trim().toLowerCase();
    return !r.timedOut && r.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  }

  async message(sha: Sha): Promise<string> {
    const r = await this.runner.run({ command: "git", args: hardenGitArgs(["log", "-1", "--format=%B", sha.value], this.repoDir), cwd: this.repoDir, env: scrubEnv() });
    return r.stdout.trim();
  }

  async ancestor(sha: Sha, n: number): Promise<Sha> {
    const r = await this.runner.run({ command: "git", args: hardenGitArgs(["rev-parse", "--verify", `${sha.value}~${n}^{commit}`], this.repoDir), cwd: this.repoDir, env: scrubEnv() });
    if (r.timedOut) throw new Error(`git rev-parse timed out for ${sha.value}~${n}`);
    if (r.exitCode !== 0) throw new Error(`git rev-parse failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    return Sha.of(r.stdout.trim());
  }

  /*
   * One file as it was at `ref` (a commit, or a commit with `^` or `~n`); undefined when the file does not exist there, git cannot
   * name the ref, or the file is larger than a contract file can be. The ref is checked against a closed grammar and the path
   * against option-like and NUL input before they reach git's `<ref>:<path>` argument.
   */
  async fileAt(ref: string, path: string): Promise<string | undefined> {
    if (!/^[0-9a-f]{4,64}([~^][0-9]*)?$/i.test(ref) || path === "" || path.startsWith("-") || path.includes("\0") || path.includes("..")) return undefined;
    const r = await this.runner.run({ command: "git", args: hardenGitArgs(["show", `${ref}:${path}`], this.repoDir), cwd: this.repoDir, env: scrubEnv() });
    if (r.timedOut || r.exitCode !== 0 || r.stdout.length > MAX_FILE_AT_CHARS) return undefined;
    return r.stdout;
  }

  async blastRadius(sha: Sha, opts?: { baseSha?: Sha; commits?: number }): Promise<BlastRadius> {
    const diff = await this.diff(sha, opts);
    return BlastRadius.of(sha, this.parser.changedFiles(diff), this.parser.touchedLines(diff));
  }

  /* Other commits' messages in `baseSha..sha` (both merge parents), excluding sha itself (head comes from message(sha)). Drop the head by hash prefix, never message or exact equality — `%H` is the full hash while sha.value may be abbreviated. [] when baseSha === sha. */
  async otherMessages(sha: Sha, opts: { baseSha: Sha }): Promise<string[]> {
    if (opts.baseSha.value === sha.value) return [];
    /* Per-commit records `<hash>%x00<message>%x00`. NUL delimiters mean a multi-line body cannot be mistaken for a record boundary. */
    const r = await this.runner.run({
      command: "git",
      args: hardenGitArgs(["log", `${opts.baseSha.value}..${sha.value}`, "--format=%H%x00%B%x00"], this.repoDir),
      cwd: this.repoDir,
      env: scrubEnv(),
    });
    if (r.timedOut) throw new Error(`git log timed out for ${opts.baseSha.value}..${sha.value}`);
    if (r.exitCode !== 0) throw new Error(`git log failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    const fields = r.stdout.split("\0");
    const messages: string[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const hash = fields[i]!.replace(/^\n+/, "").trim().toLowerCase();
      const message = fields[i + 1]!.replace(/^\n+/, "").replace(/\n+$/, "");
      if (!hash) continue; /* trailing empty tail after the last record's NUL */
      if (hash.startsWith(sha.value)) continue;
      if (message.length > 0) messages.push(message);
    }
    return messages;
  }
}
