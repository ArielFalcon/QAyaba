/* Shared kernel: the run input (run-orchestration) and the classify port (change-analysis) both name it. The repos one run reads, each at its head: the primary repo and the services a change reaches. Pure value object; the run derives its sha, base and trigger repo from the anchor entry. */

import type { Sha } from "@kernel/sha.ts";

export type ChangeRole = "primary" | "service";

export interface ChangeEntry {
  readonly repo: string;
  readonly role: ChangeRole;
  readonly headSha: Sha;
  /* The range starts here. Mutually exclusive with `commits`. */
  readonly baseSha?: Sha;
  /* The range spans this many commits ending at the head. Mutually exclusive with `baseSha`. */
  readonly commits?: number;
}

export class ChangeSet {
  private constructor(readonly app: string, readonly entries: readonly ChangeEntry[]) {}

  static of(app: string, entries: readonly ChangeEntry[]): ChangeSet {
    if (entries.length === 0) throw new Error(`ChangeSet: ${app} needs at least one entry`);
    const seen = new Set<string>();
    for (const e of entries) {
      if (seen.has(e.repo)) throw new Error(`ChangeSet: ${app} holds ${e.repo} more than once`);
      seen.add(e.repo);
      if (e.baseSha && e.commits !== undefined) throw new Error(`ChangeSet: ${e.repo} carries both baseSha and commits`);
      if (e.commits !== undefined && (!Number.isInteger(e.commits) || e.commits < 1)) throw new Error(`ChangeSet: commits of ${e.repo} must be a positive integer`);
    }
    return new ChangeSet(app, [...entries]);
  }

  /* The primary entry when there is one, else the first entry. */
  get anchor(): ChangeEntry {
    return this.entries.find((e) => e.role === "primary") ?? this.entries[0]!;
  }
}

/* The run input's sha, base and trigger repo, derived from the anchor so the set and its projection never disagree. A service anchor names its repo as the trigger repo. */
export function anchorProjection(set: ChangeSet): { sha: Sha; baseSha?: Sha; triggerRepo?: string } {
  const a = set.anchor;
  return {
    sha: a.headSha,
    ...(a.baseSha ? { baseSha: a.baseSha } : {}),
    ...(a.role === "service" ? { triggerRepo: a.repo } : {}),
  };
}
