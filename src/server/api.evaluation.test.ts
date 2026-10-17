import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleApi, type ApiDeps } from "./api";
import { RegradeRequestError } from "@contexts/evaluation/application/regrade.use-case";
import { GRADER_CATALOG } from "@contexts/evaluation/domain/grader-catalog";
import { RUN_PHASES } from "@contexts/qa-run-orchestration/domain/run-phase-cursor";
import { CreateRunResultSchema, EvaluationCatalogSchema, RegradeJobSchema, RunDetailSchema, RunEvaluationSchema } from "../contract/commands";
import type { RunRecord } from "../types";
import type { EvaluationService } from "./evaluation-service";
import type { RunViewExtras } from "./run-view";

function mkReq(method: string, url: string, body?: string): any {
  const r: any = Readable.from(body != null ? [body] : []);
  r.method = method;
  r.url = url;
  r.headers = { host: "localhost" };
  return r;
}

function mkRes(): any {
  return {
    status: 0,
    body: "",
    writeHead(s: number) {
      this.status = s;
    },
    setHeader() {},
    write(chunk: string) {
      this.body += chunk;
    },
    end(b?: string) {
      this.body = b ?? this.body;
    },
  };
}

const record: RunRecord = { id: "run-1", app: "demo", sha: "abc1234", target: "e2e", mode: "diff", status: "done", verdict: "pass", cases: [], logs: [], at: "2026-10-17T10:00:00.000Z" };

const extras: RunViewExtras = {
  telemetry: { traceId: "a".repeat(32), traceUrl: "http://grafana/trace/" + "a".repeat(32) },
  phases: [{ name: "gate", durationMs: 5 }, { name: "generate", durationMs: 900 }],
  furthestPhase: "learn",
  usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, costUsd: 0.25 },
  specCounts: { generated: 2, valid: 2, passed: 1 },
  decision: "pr",
  budgets: { exhausted: false },
};

const evaluation: EvaluationService = {
  scheduleGrading: () => undefined,
  evaluation: (id, all) =>
    id === "run-1"
      ? {
          runId: id,
          traceId: null,
          status: "complete",
          scores: [
            { name: "spec_pass_rate", value: 0.5, dataType: "NUMERIC", polarity: "higher_better", source: "deterministic", graderVersion: "2", comment: "1 of 2" },
            ...(all ? [{ name: "spec_pass_rate", value: 0.4, dataType: "NUMERIC" as const, polarity: "higher_better" as const, source: "deterministic" as const, graderVersion: "1" }] : []),
          ],
        }
      : undefined,
  startRegrade: (req) => {
    if ("runIds" in req && req.graders?.includes("bogus")) throw new RegradeRequestError("unknown grader: bogus");
    return { jobId: "job-1", runs: "runIds" in req ? req.runIds.length : 0 };
  },
  regradeJob: (id) => (id === "job-1" ? { jobId: id, status: "running", runs: 2, graded: 1, failed: [{ runId: "r2", error: "boom" }], startedAt: "2026-10-17T10:00:00.000Z" } : undefined),
  recoverInterrupted: () => 0,
};

function deps(over: Partial<ApiDeps> = {}): ApiDeps {
  return {
    queue: { size: 0 },
    enqueue: () => "run-new",
    loadApp: (n) => {
      if (n === "demo") return { name: "demo", repo: "o/d", qa: { shadow: false, needsReview: true, testDataPrefix: "qa" } } as never;
      throw new Error("nope");
    },
    listApps: () => [],
    resolveRef: async () => "f".repeat(40),
    getRecord: (id) => (id === "run-1" ? record : undefined),
    listRecords: () => [],
    currentRun: () => undefined,
    runExtras: (id) => (id === "run-1" ? extras : undefined),
    evaluation,
    ...over,
  };
}

async function call(method: string, url: string, body?: string, d: ApiDeps = deps()) {
  const res = mkRes();
  await handleApi(mkReq(method, url, body), res, d);
  return { status: res.status as number, json: JSON.parse(res.body) as Record<string, any> };
}

test("GET /runs/:id carries the run record plus telemetry, phases, usage, spec counts, decision and budgets", async () => {
  const { status, json } = await call("GET", "/api/v1/runs/run-1");
  assert.equal(status, 200);
  assert.equal(json.schemaVersion, 1);
  RunDetailSchema.parse(json);
  assert.equal(json.id, "run-1");
  assert.equal(json.telemetry.traceId, extras.telemetry!.traceId);
  assert.deepEqual(json.phases.map((p: { name: string }) => p.name), ["gate", "generate"]);
  assert.equal(json.specCounts.passed, 1);
  assert.equal(json.budgets.exhausted, false);
});

test("GET /runs/:id answers telemetry null when the run view says so", async () => {
  const { json } = await call("GET", "/api/v1/runs/run-1", undefined, deps({ runExtras: () => ({ ...extras, telemetry: null }) }));
  assert.equal(json.telemetry, null);
});

test("GET /runs/:id of an unknown run is a 404 with schemaVersion", async () => {
  const { status, json } = await call("GET", "/api/v1/runs/ghost");
  assert.equal(status, 404);
  assert.equal(json.schemaVersion, 1);
  assert.equal(typeof json.error, "string");
});

test("POST /runs answers 202 with schemaVersion and every error body carries it too", async () => {
  const ok = await call("POST", "/api/v1/runs", JSON.stringify({ app: "demo", sha: "abc1234" }));
  assert.equal(ok.status, 202);
  CreateRunResultSchema.parse(ok.json);
  assert.equal(ok.json.schemaVersion, 1);
  const bad = await call("POST", "/api/v1/runs", "{nope");
  assert.equal(bad.status, 400);
  assert.equal(bad.json.schemaVersion, 1);
  const noApp = await call("POST", "/api/v1/runs", JSON.stringify({}));
  assert.equal(noApp.json.schemaVersion, 1);
  const unknown = await call("POST", "/api/v1/runs", JSON.stringify({ app: "ghost" }));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.schemaVersion, 1);
  const badSha = await call("POST", "/api/v1/runs", JSON.stringify({ app: "demo", sha: "zz" }));
  assert.equal(badSha.json.schemaVersion, 1);
});

test("GET /runs/:id/evaluation returns the latest versions by default and every version with ?versions=all", async () => {
  const latest = await call("GET", "/api/v1/runs/run-1/evaluation");
  assert.equal(latest.status, 200);
  RunEvaluationSchema.parse(latest.json);
  assert.equal(latest.json.schemaVersion, 1);
  assert.equal(latest.json.status, "complete");
  assert.equal(latest.json.scores.length, 1);
  const all = await call("GET", "/api/v1/runs/run-1/evaluation?versions=all");
  assert.equal(all.json.scores.length, 2);
});

test("GET /runs/:id/evaluation refuses an unknown versions value and an unknown run, with schemaVersion", async () => {
  const bad = await call("GET", "/api/v1/runs/run-1/evaluation?versions=latest");
  assert.equal(bad.status, 400);
  assert.equal(bad.json.schemaVersion, 1);
  const ghost = await call("GET", "/api/v1/runs/ghost/evaluation");
  assert.equal(ghost.status, 404);
  assert.equal(ghost.json.schemaVersion, 1);
});

test("GET /evaluations/catalog is the grader catalog with the canonical phase order", async () => {
  const { status, json } = await call("GET", "/api/v1/evaluations/catalog");
  assert.equal(status, 200);
  EvaluationCatalogSchema.parse(json);
  assert.equal(json.schemaVersion, 1);
  assert.deepEqual(json.phases, [...RUN_PHASES]);
  assert.deepEqual(json.scores.map((s: { name: string }) => s.name), GRADER_CATALOG.map((s) => s.name));
  const mix = json.scores.find((s: { name: string }) => s.name === "step_intent_mix");
  assert.deepEqual(mix.suffixes, ["auth", "explore", "write_spec", "run_spec", "review", "other"]);
  assert.equal(mix.polarity, "none");
});

test("POST /evaluations/regrade accepts exactly one selector and answers 202 with the job id and run count", async () => {
  const { status, json } = await call("POST", "/api/v1/evaluations/regrade", JSON.stringify({ runIds: ["a", "b"] }));
  assert.equal(status, 202);
  assert.deepEqual(json, { schemaVersion: 1, jobId: "job-1", runs: 2 });
});

test("POST /evaluations/regrade refuses a request with no selector, two selectors, bad JSON or an unknown grader", async () => {
  for (const body of ["{}", JSON.stringify({ runIds: ["a"], since: "2026-01-01" }), "{nope", JSON.stringify({ runIds: ["a"], graders: ["bogus"] })]) {
    const { status, json } = await call("POST", "/api/v1/evaluations/regrade", body);
    assert.equal(status, 400, body);
    assert.equal(json.schemaVersion, 1, body);
    assert.equal(typeof json.error, "string");
  }
});

test("GET /evaluations/regrade/:jobId reports progress and the runs that failed", async () => {
  const { status, json } = await call("GET", "/api/v1/evaluations/regrade/job-1");
  assert.equal(status, 200);
  RegradeJobSchema.parse(json);
  assert.equal(json.status, "running");
  assert.deepEqual(json.failed, [{ runId: "r2", error: "boom" }]);
  const ghost = await call("GET", "/api/v1/evaluations/regrade/ghost");
  assert.equal(ghost.status, 404);
  assert.equal(ghost.json.schemaVersion, 1);
});

test("the evaluation routes answer 501 with schemaVersion when evaluation is not wired", async () => {
  const d = deps();
  delete d.evaluation;
  for (const [m, u, b] of [["GET", "/api/v1/runs/run-1/evaluation"], ["GET", "/api/v1/evaluations/catalog"], ["POST", "/api/v1/evaluations/regrade", "{}"], ["GET", "/api/v1/evaluations/regrade/x"]] as const) {
    const { status, json } = await call(m, u, b, d);
    assert.equal(status, 501, u);
    assert.equal(json.schemaVersion, 1, u);
  }
});

test("GET /runs/:id reports unknown validity and pass counts as null", async () => {
  const { status, json } = await call("GET", "/api/v1/runs/run-1", undefined, deps({ runExtras: () => ({ ...extras, specCounts: { generated: 2, valid: null, passed: null } }) }));
  assert.equal(status, 200);
  assert.deepEqual(json.specCounts, { generated: 2, valid: null, passed: null });
});

test("POST /evaluations/regrade refuses more than 500 run ids", async () => {
  const many = Array.from({ length: 501 }, (_, i) => `r${i}`);
  const { status, json } = await call("POST", "/api/v1/evaluations/regrade", JSON.stringify({ runIds: many }));
  assert.equal(status, 400);
  assert.equal(json.schemaVersion, 1);
});

test("POST /evaluations/regrade answers 400 with the service's reason for a bad since or a pending grader", async () => {
  const refusing: EvaluationService = { ...evaluation, startRegrade: () => { throw new RegradeRequestError("'since' must be an ISO-8601 date"); } };
  const { status, json } = await call("POST", "/api/v1/evaluations/regrade", JSON.stringify({ since: "yesterday" }), deps({ evaluation: refusing }));
  assert.equal(status, 400);
  assert.match(json.error, /ISO-8601/);
});
