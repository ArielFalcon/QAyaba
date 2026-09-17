import { Sha } from "@kernel/sha.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import type { SandboxedBinaryRunner } from "../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import type { VcsReadPort } from "../application/ports/index.ts";

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
      args: ["diff", "--no-color", baseRef, sha.value],
      cwd: this.repoDir,
      env: scrubEnv(),
    });
    /* Throw on VCS error — a non-zero exit or timeout must not become an empty diff ("no changed files"). */
    if (r.timedOut) throw new Error(`git diff timed out for ${baseRef}..${sha.value}`);
    if (r.exitCode !== 0) throw new Error(`git diff failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    return r.stdout;
  }

  async message(sha: Sha): Promise<string> {
    const r = await this.runner.run({ command: "git", args: ["log", "-1", "--format=%B", sha.value], cwd: this.repoDir, env: scrubEnv() });
    return r.stdout.trim();
  }

  async blastRadius(sha: Sha, opts?: { baseSha?: Sha; commits?: number }): Promise<BlastRadius> {
    const diff = await this.diff(sha, opts);
    return BlastRadius.of(sha, this.parser.changedFiles(diff));
  }

  /* Other commits' messages in `baseSha..sha` (both merge parents), excluding sha itself (head comes from message(sha)). Drop the head by hash prefix, never message or exact equality — `%H` is the full hash while sha.value may be abbreviated. [] when baseSha === sha. */
  async otherMessages(sha: Sha, opts: { baseSha: Sha }): Promise<string[]> {
    if (opts.baseSha.value === sha.value) return [];
    /* Per-commit records `<hash>%x00<message>%x00`. NUL delimiters mean a multi-line body cannot be mistaken for a record boundary. */
    const r = await this.runner.run({
      command: "git",
      args: ["log", `${opts.baseSha.value}..${sha.value}`, "--format=%H%x00%B%x00"],
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
