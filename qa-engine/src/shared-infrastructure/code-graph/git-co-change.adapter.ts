/*
 * CoChangePort over git history, read through the trusted git runner with hardened arguments. The window is the run's
 * commit's ancestors, reached through its parents so the commit itself is left out whether or not it is a merge (merges
 * excluded), the last HISTORY_COMMITS of them. A commit that touched more than BULK_COMMIT_FILES files (a rename sweep, a formatter run, a vendored drop) couples everything with everything and
 * is ignored. A file is coupled to a changed file when they changed together at least MIN_CO_CHANGES times and in at least
 * MIN_COUPLING of the changed file's commits; its score is the strongest such fraction over the changed files.
 */

import { err, ok, type Result } from "../../shared-kernel/result.ts";
import type { BlastRadius } from "../../shared-kernel/blast-radius.ts";
import type { CoChangePort } from "../../shared-kernel/ports/co-change.port.ts";
import type { CodeGraphUnavailable, CoupledFile } from "../../shared-kernel/code/index.ts";
import { hardenGitArgs } from "../process-sandbox/git-hardening.ts";
import { scrubEnv } from "../process-sandbox/scrub-env.ts";
import type { SandboxedBinaryRunner } from "../process-sandbox/sandboxed-binary-runner.ts";

export const HISTORY_COMMITS = 500;
export const BULK_COMMIT_FILES = 50;
export const MIN_CO_CHANGES = 2;
export const MIN_COUPLING = 0.3;
const MAX_RESULTS = 200;
const GIT_TIMEOUT_MS = 30_000;
const RECORD = "\u001e";

interface HistoryCommit {
  date: string;
  files: string[];
}

/* Parses `git log --format=%x1e%cI --name-only` output into commits, newest first. */
export function parseHistory(out: string): HistoryCommit[] {
  const commits: HistoryCommit[] = [];
  for (const chunk of out.split(RECORD)) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    if (lines.length === 0) continue;
    const [date, ...files] = lines;
    commits.push({ date: date!, files: [...new Set(files)] });
  }
  return commits;
}

/* The coupling of every other file to the changed ones over the given history. Pure. */
export function couplingOf(history: readonly HistoryCommit[], changedFiles: readonly string[]): CoupledFile[] {
  const changed = new Set(changedFiles);
  const touches = new Map<string, number>();
  const pairs = new Map<string, Map<string, { count: number; last: string }>>();
  for (const commit of history) {
    if (commit.files.length > BULK_COMMIT_FILES) continue;
    const hit = commit.files.filter((f) => changed.has(f));
    if (hit.length === 0) continue;
    for (const f of hit) {
      touches.set(f, (touches.get(f) ?? 0) + 1);
      const row = pairs.get(f) ?? pairs.set(f, new Map()).get(f)!;
      for (const g of commit.files) {
        if (changed.has(g)) continue;
        const cell = row.get(g);
        if (cell) cell.count++;
        else row.set(g, { count: 1, last: commit.date });
      }
    }
  }
  const best = new Map<string, CoupledFile>();
  for (const [f, row] of pairs) {
    const total = touches.get(f)!;
    for (const [g, { count, last }] of row) {
      const score = count / total;
      if (count < MIN_CO_CHANGES || score < MIN_COUPLING) continue;
      const prior = best.get(g);
      if (!prior || score > prior.couplingScore || (score === prior.couplingScore && count > prior.coChanges)) {
        best.set(g, { file: g, couplingScore: Math.round(score * 1000) / 1000, coChanges: count, lastCoChange: last });
      }
    }
  }
  return [...best.values()]
    .sort((a, b) => b.couplingScore - a.couplingScore || b.coChanges - a.coChanges || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .slice(0, MAX_RESULTS);
}

export class GitCoChangeAdapter implements CoChangePort {
  constructor(private readonly git: SandboxedBinaryRunner) {}

  async coChangeCoupling(repoDir: string, changed: BlastRadius): Promise<Result<CoupledFile[], CodeGraphUnavailable>> {
    if (changed.isEmpty) return ok([]);
    const args = ["log", "--no-merges", "--no-renames", `--max-count=${HISTORY_COMMITS}`, "--format=%x1e%cI", "--name-only", `${changed.sha.value}^@`, "--"];
    try {
      const r = await this.git.run({ command: "git", args: hardenGitArgs(args, repoDir), cwd: repoDir, env: scrubEnv(), timeoutMs: GIT_TIMEOUT_MS });
      if (r.timedOut) return err({ reason: "git log timed out" });
      if (r.exitCode !== 0) return err({ reason: `git log exited ${r.exitCode}: ${r.stderr.trim().slice(0, 200)}` });
      return ok(couplingOf(parseHistory(r.stdout), changed.changedFiles));
    } catch (e) {
      return err({ reason: e instanceof Error ? e.message : String(e) });
    }
  }
}
