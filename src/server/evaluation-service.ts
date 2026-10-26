/*
 * The shell's composition of the evaluation context: SQLite adapters for its ports and the small facade the runner and the API use.
 * Grading is always scheduled, never awaited: a run's queue slot, its verdict and the next run are untouched by what a grader does.
 */

import { randomBytes } from "node:crypto";
import { GradeRunUseCase } from "@contexts/evaluation/application/index";
import { RegradeUseCase, MAX_REGRADE_RUNS, type RegradeRequest } from "@contexts/evaluation/application/index";
import type { EvaluationStatus, RegradeJob, RegradeJobStorePort, RunSelectorPort, ScoreSinkPort, ScoreStorePort, EvidencePort } from "@contexts/evaluation/application/index.ts";
import { campaignRunsView, type CampaignRunRow, type CampaignRunView } from "@contexts/evaluation/application/index";
import { GRADER_CATALOG } from "@contexts/evaluation/application/index";
import type { JudgeCatalogEntry } from "@contexts/evaluation/application/index";
import type { JudgeRegradePort } from "@contexts/evaluation/application/index.ts";
import type { Score, ScoreDataType, ScorePolarity, ScoreSource } from "@contexts/evaluation/application/index";
import { RUN_PHASES } from "@kernel/run-step";
import {
  failInterruptedRegradeJobs,
  getRegradeJob,
  getRunEvaluationStatus,
  getRunFacts,
  listCampaignRuns,
  listFinishedCampaignRunIds,
  listFinishedRunIdsSince,
  listRunScoreRows,
  replaceRunScores,
  runExists,
  saveRegradeJob,
  setRunEvaluationStatus,
} from "./history";
import { HistoryEvidenceAdapter } from "./evaluation-evidence";
import { RedactionPortAdapter } from "../orchestrator/sanitizer";

const redaction = new RedactionPortAdapter();

/* The newest grader version wins; versions are compared as numbers when they are, as strings otherwise. */
function newer(a: string, b: string): boolean {
  const na = Number(a);
  const nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb) ? na > nb : a.localeCompare(b, undefined, { numeric: true }) > 0;
}

export class SqliteScoreStore implements ScoreStorePort {
  replace(runId: string, scores: readonly Score[], gradedAt: string, scope: { graderVersion: string; baseNames?: readonly string[] }): void {
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
        judgeModel: s.judgeModel ?? null,
      })),
      gradedAt,
      { runId, ...scope },
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
      ...(r.judgeModel ? { judgeModel: r.judgeModel } : {}),
    }));
    if (opts.allVersions) return scores;
    /* The default view is the graders' (design §14): a human label (graderVersion "human", never a version number) shows only with all versions. */
    const latest = new Map<string, Score>();
    for (const s of scores) {
      if (s.source === "human") continue;
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
  finishedSince(sinceIso: string): string[] {
    return listFinishedRunIdsSince(sinceIso);
  }

  /* The campaign's finished runs. One more than a regrade may cover is returned at most, so the use case can refuse an oversized campaign instead of silently grading part of it. */
  ofCampaign(campaignId: string): string[] {
    return listFinishedCampaignRunIds(campaignId, MAX_REGRADE_RUNS);
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
  /* LLM judges only (additive, section 14). */
  status?: "experimental" | "calibrated";
}

/* The graders, then the LLM judges (when the pinned judge prompt declares a version): the machine-readable source of names, types, polarity and judge status. */
export function catalogView(judges: readonly JudgeCatalogEntry[] = []): { phases: string[]; scores: CatalogScoreView[] } {
  return {
    phases: [...RUN_PHASES],
    scores: [
      ...GRADER_CATALOG.map((s) => ({
        name: s.name,
        dataType: s.dataType,
        polarity: s.polarity,
        ...(s.range ? { range: { ...s.range } } : {}),
        ...(s.categories ? { categories: [...s.categories] } : {}),
        ...(s.suffixes ? { suffixes: [...s.suffixes] } : {}),
        graderVersion: s.graderVersion,
      })),
      ...judges.map((j) => ({
        name: j.name,
        dataType: j.dataType,
        polarity: j.polarity,
        ...(j.categories ? { categories: [...j.categories] } : {}),
        graderVersion: j.graderVersion,
        status: j.status,
      })),
    ],
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

export interface CampaignRunsView {
  campaignId: string;
  runs: CampaignRunView[];
  complete: boolean;
}

/* What the runner and the API see of the evaluation context. */
export interface EvaluationService {
  /* Grades the run later, off the caller's path. Never throws, never blocks. */
  scheduleGrading(runId: string): void;
  /* Undefined: no such run. */
  evaluation(runId: string, allVersions: boolean): RunEvaluationView | undefined;
  startRegrade(request: RegradeRequest): { jobId: string; runs: number };
  regradeJob(jobId: string): RegradeJobView | undefined;
  /* The campaign's runs (narrowed to those carrying every label of `variant`) and whether they are all done and graded. */
  campaignRuns(campaignId: string, variant: Readonly<Record<string, string>>): CampaignRunsView;
  /* Boot: ends the jobs a previous process left open. */
  recoverInterrupted(): number;
  /* The score catalog: the graders, then the LLM judges with their status. */
  catalog(): { phases: string[]; scores: CatalogScoreView[] };
}

export interface EvaluationServiceDeps {
  evidence?: EvidencePort;
  store?: ScoreStorePort;
  jobs?: RegradeJobStorePort;
  runs?: RunSelectorPort;
  /* Every run of a campaign with its grading status. Default: the history. */
  campaignRows?: (campaignId: string) => CampaignRunRow[];
  sink?: ScoreSinkPort;
  /* The LLM judges the catalog lists and a regrade may name. Absent: no judge is listed and a regrade naming one is refused. */
  judges?: JudgeRegradePort & { catalog(): JudgeCatalogEntry[] };
  now?: () => string;
  newId?: () => string;
  /* Runs `fn` after the current call stack, off the caller's path. */
  schedule?: (fn: () => void) => void;
  yieldToLoop?: () => Promise<void>;
  log?: (message: string) => void;
  /* Redacts a text before it is stored on a job and served (default: the outbound redaction port). */
  sanitize?: (text: string) => string;
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
    ...(deps.judges ? { judges: deps.judges } : {}),
    sanitize: deps.sanitize ?? ((text: string) => redaction.redact(text)),
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
    campaignRuns(campaignId, variant) {
      return { campaignId, ...campaignRunsView((deps.campaignRows ?? listCampaignRuns)(campaignId), variant) };
    },
    recoverInterrupted() {
      return failInterruptedRegradeJobs(now());
    },
    catalog() {
      return catalogView(deps.judges?.catalog() ?? []);
    },
  };
}
