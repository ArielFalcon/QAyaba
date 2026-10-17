/*
 * The shell's composition of the evaluation context: SQLite adapters for its ports and the small facade the runner and the API use.
 * Grading is always scheduled, never awaited: a run's queue slot, its verdict and the next run are untouched by what a grader does.
 */

import { randomBytes } from "node:crypto";
import { GradeRunUseCase } from "@contexts/evaluation/application/grade-run.use-case";
import { RegradeUseCase, type RegradeRequest } from "@contexts/evaluation/application/regrade.use-case";
import type { EvaluationStatus, RegradeJob, RegradeJobStorePort, RunSelectorPort, ScoreSinkPort, ScoreStorePort, EvidencePort } from "@contexts/evaluation/application/ports/index";
import { GRADER_CATALOG } from "@contexts/evaluation/domain/grader-catalog";
import type { Score, ScoreDataType, ScorePolarity, ScoreSource } from "@contexts/evaluation/domain/score";
import { RUN_PHASES } from "@contexts/qa-run-orchestration/domain/run-phase-cursor";
import {
  failInterruptedRegradeJobs,
  getRegradeJob,
  getRunEvaluationStatus,
  getRunFacts,
  listFinishedRunIdsSince,
  listRunScoreRows,
  replaceRunScores,
  runExists,
  saveRegradeJob,
  setRunEvaluationStatus,
} from "./history";
import { HistoryEvidenceAdapter } from "./evaluation-evidence";

/* The newest grader version wins; versions are compared as numbers when they are, as strings otherwise. */
function newer(a: string, b: string): boolean {
  const na = Number(a);
  const nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb) ? na > nb : a.localeCompare(b, undefined, { numeric: true }) > 0;
}

export class SqliteScoreStore implements ScoreStorePort {
  replace(runId: string, scores: readonly Score[], gradedAt: string): void {
    replaceRunScores(
      scores.map((s) => ({
        runId,
        name: s.name,
        graderVersion: s.graderVersion,
        dataType: s.dataType,
        polarity: s.polarity,
        source: s.source,
        value: s.value,
        comment: s.comment ?? null,
        observationId: s.observationId ?? null,
      })),
      gradedAt,
    );
  }

  list(runId: string, opts: { allVersions: boolean }): Score[] {
    const scores: Score[] = listRunScoreRows(runId).map((r) => ({
      name: r.name,
      value: r.value,
      dataType: r.dataType as ScoreDataType,
      polarity: r.polarity as ScorePolarity,
      source: r.source as ScoreSource,
      graderVersion: r.graderVersion,
      ...(r.comment !== null ? { comment: r.comment } : {}),
      ...(r.observationId !== null ? { observationId: r.observationId } : {}),
    }));
    if (opts.allVersions) return scores;
    const latest = new Map<string, Score>();
    for (const s of scores) {
      const cur = latest.get(s.name);
      if (!cur || newer(s.graderVersion, cur.graderVersion)) latest.set(s.name, s);
    }
    return [...latest.values()];
  }

  setStatus(runId: string, status: EvaluationStatus, at: string): void {
    setRunEvaluationStatus(runId, status, at);
  }

  status(runId: string): EvaluationStatus {
    const s = getRunEvaluationStatus(runId);
    return s === "complete" || s === "failed" ? s : "pending";
  }
}

export class SqliteRegradeJobStore implements RegradeJobStorePort {
  create(job: RegradeJob): void {
    this.update(job);
  }

  update(job: RegradeJob): void {
    saveRegradeJob({ ...job, graders: job.graders ?? null, finishedAt: job.finishedAt ?? null });
  }

  get(jobId: string): RegradeJob | undefined {
    const r = getRegradeJob(jobId);
    if (!r) return undefined;
    return { ...r, status: r.status as RegradeJob["status"], graders: r.graders ?? undefined, finishedAt: r.finishedAt ?? undefined };
  }
}

export class HistoryRunSelector implements RunSelectorPort {
  exists(runId: string): boolean {
    return runExists(runId);
  }

  finishedSince(sinceIso: string): string[] {
    return listFinishedRunIdsSince(sinceIso);
  }

  /* Runs do not carry a campaign yet; a campaign filter covers nothing until they do. */
  ofCampaign(_campaignId: string): string[] {
    return [];
  }
}

/* The wire shape of a catalog entry (GET /evaluations/catalog). */
export interface CatalogScoreView {
  name: string;
  dataType: ScoreDataType;
  polarity: ScorePolarity;
  range?: { min: number; max?: number };
  categories?: string[];
  suffixes?: string[];
  graderVersion: string;
}

export function catalogView(): { phases: string[]; scores: CatalogScoreView[] } {
  return {
    phases: [...RUN_PHASES],
    scores: GRADER_CATALOG.map((s) => ({
      name: s.name,
      dataType: s.dataType,
      polarity: s.polarity,
      ...(s.range ? { range: { ...s.range } } : {}),
      ...(s.categories ? { categories: [...s.categories] } : {}),
      ...(s.suffixes ? { suffixes: [...s.suffixes] } : {}),
      graderVersion: s.graderVersion,
    })),
  };
}

export interface RunEvaluationView {
  runId: string;
  traceId: string | null;
  status: EvaluationStatus;
  scores: Score[];
}

export interface RegradeJobView {
  jobId: string;
  status: RegradeJob["status"];
  runs: number;
  graded: number;
  failed: Array<{ runId: string; error: string }>;
  startedAt: string;
  finishedAt?: string;
}

/* What the runner and the API see of the evaluation context. */
export interface EvaluationService {
  /* Grades the run later, off the caller's path. Never throws, never blocks. */
  scheduleGrading(runId: string): void;
  /* Undefined: no such run. */
  evaluation(runId: string, allVersions: boolean): RunEvaluationView | undefined;
  startRegrade(request: RegradeRequest): { jobId: string; runs: number };
  regradeJob(jobId: string): RegradeJobView | undefined;
  /* Boot: ends the jobs a previous process left open. */
  recoverInterrupted(): number;
}

export interface EvaluationServiceDeps {
  evidence?: EvidencePort;
  store?: ScoreStorePort;
  jobs?: RegradeJobStorePort;
  runs?: RunSelectorPort;
  sink?: ScoreSinkPort;
  now?: () => string;
  newId?: () => string;
  /* Runs `fn` after the current call stack, off the caller's path. */
  schedule?: (fn: () => void) => void;
  yieldToLoop?: () => Promise<void>;
  log?: (message: string) => void;
}

export function createEvaluationService(deps: EvaluationServiceDeps = {}): EvaluationService {
  const store = deps.store ?? new SqliteScoreStore();
  const jobs = deps.jobs ?? new SqliteRegradeJobStore();
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.log ?? ((m: string) => console.error(m));
  const schedule = deps.schedule ?? ((fn: () => void) => void setImmediate(fn));
  const grade = new GradeRunUseCase({
    evidence: deps.evidence ?? new HistoryEvidenceAdapter(),
    store,
    ...(deps.sink ? { sink: deps.sink } : {}),
    now,
    log,
  });
  const regrade = new RegradeUseCase({
    runs: deps.runs ?? new HistoryRunSelector(),
    jobs,
    grade,
    newId: deps.newId ?? (() => `regrade-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`),
    now,
    yieldToLoop: deps.yieldToLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve))),
  });
  return {
    scheduleGrading(runId) {
      try {
        schedule(() => {
          grade.execute(runId).catch((err: unknown) => log(`[evaluation] grading ${runId} crashed: ${err instanceof Error ? err.message : String(err)}`));
        });
      } catch (err) {
        log(`[evaluation] could not schedule grading of ${runId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    evaluation(runId, allVersions) {
      if (!runExists(runId)) return undefined;
      return {
        runId,
        traceId: getRunFacts(runId)?.traceId ?? null,
        status: store.status(runId),
        scores: store.list(runId, { allVersions }),
      };
    },
    startRegrade(request) {
      const started = regrade.start(request);
      schedule(() => {
        regrade.run(started.jobId).catch((err: unknown) => log(`[evaluation] regrade ${started.jobId} crashed: ${err instanceof Error ? err.message : String(err)}`));
      });
      return started;
    },
    regradeJob(jobId) {
      const job = jobs.get(jobId);
      if (!job) return undefined;
      return {
        jobId: job.jobId,
        status: job.status,
        runs: job.runs,
        graded: job.graded,
        failed: job.failed,
        startedAt: job.startedAt,
        ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
      };
    },
    recoverInterrupted() {
      return failInterruptedRegradeJobs(now());
    },
  };
}
