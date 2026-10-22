import type { EvaluationStatus, RegradeJob, RegradeJobStorePort, RunSelectorPort, ScoreStorePort } from "@contexts/evaluation/application/ports/index.ts";
import type { Score } from "@contexts/evaluation/domain/score.ts";

/* An in-memory store with the contract of the SQLite one: key (runId, name, graderVersion). */
export class MemoryScoreStore implements ScoreStorePort {
  readonly rows = new Map<string, Score>();
  readonly statuses = new Map<string, EvaluationStatus>();

  replace(runId: string, scores: readonly Score[], _gradedAt: string, scope: { graderVersion: string; baseNames?: readonly string[] }): void {
    for (const key of [...this.rows.keys()]) {
      const [rid, name, version] = key.split("|") as [string, string, string];
      if (rid !== runId || version !== scope.graderVersion) continue;
      if (!scope.baseNames || scope.baseNames.some((b) => name === b || name.startsWith(`${b}.`))) this.rows.delete(key);
    }
    for (const s of scores) this.rows.set(`${runId}|${s.name}|${s.graderVersion}`, s);
  }

  list(runId: string, opts: { allVersions: boolean }): Score[] {
    const mine = [...this.rows.entries()].filter(([k]) => k.startsWith(`${runId}|`)).map(([, s]) => s);
    if (opts.allVersions) return mine;
    const latest = new Map<string, Score>();
    for (const s of mine) {
      const cur = latest.get(s.name);
      if (!cur || Number(s.graderVersion) > Number(cur.graderVersion)) latest.set(s.name, s);
    }
    return [...latest.values()];
  }

  setStatus(runId: string, status: EvaluationStatus): void {
    this.statuses.set(runId, status);
  }

  status(runId: string): EvaluationStatus {
    return this.statuses.get(runId) ?? "pending";
  }
}

export class MemoryJobStore implements RegradeJobStorePort {
  readonly jobs = new Map<string, RegradeJob>();
  create(job: RegradeJob): void {
    this.jobs.set(job.jobId, structuredClone(job));
  }
  update(job: RegradeJob): void {
    this.jobs.set(job.jobId, structuredClone(job));
  }
  get(jobId: string): RegradeJob | undefined {
    const j = this.jobs.get(jobId);
    return j ? structuredClone(j) : undefined;
  }
}

export function selector(opts: { since?: string[]; campaign?: Record<string, string[]> } = {}): RunSelectorPort {
  return {
    finishedSince: () => opts.since ?? [],
    ofCampaign: (id) => opts.campaign?.[id] ?? [],
  };
}
