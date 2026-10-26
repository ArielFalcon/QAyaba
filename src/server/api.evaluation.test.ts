import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleApi, type ApiDeps } from "./api";
import { AppNotFoundError } from "../orchestrator/config-loader";
import { RegradeRequestError } from "@contexts/evaluation/application/index";
import { GRADER_CATALOG } from "@contexts/evaluation/application/index";
import { RUN_PHASES } from "@kernel/run-step";
import { CampaignRunsSchema, CreateRunResultSchema, EvaluationCatalogSchema, RegradeJobSchema, RunDetailSchema, RunEvaluationSchema } from "../contract/commands";
import type { RunRecord } from "../types";
import { catalogView, type EvaluationService } from "./evaluation-service";
import { judgeCatalog } from "@contexts/evaluation/application/index";
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
  campaign: { id: "ab-1", variant: { arm: "treatment" }, replicate: 2 },
  effectiveConfig: {
    levers: { closedLoop: true, agentBrowser: false, captureMode: "metadata" },
    campaignFreeze: true,
    runtime: "opencode",
    agents: { "qa-generator": { provider: "opencode-go", model: "m1", reasoningEffort: null, stepLimit: 50 } },
    prompt: { staticHash: "sha256:abc" },
    grounding: { stitcher: "signal", structuralSignal: "signal", curriculum: "frozen", domPack: true, dossier: true },
    coverage: { mode: "signal", minRatio: 0.7 },
    reflector: false,
  },
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
  campaignRuns: (campaignId, variant) => {
    const rows = [
      { id: "run-1", variant: { arm: "control" }, replicate: 1, status: "done" as const, evaluationStatus: "complete" as const, verdict: "pass" },
      { id: "run-2", variant: { arm: "treatment" }, replicate: 1, status: "done" as const, evaluationStatus: "pending" as const },
    ].filter((r) => Object.entries(variant).every(([k, v]) => (r.variant as Record<string, string>)[k] === v));
    return { campaignId, runs: rows, complete: rows.length > 0 && rows.every((r) => r.evaluationStatus === "complete") };
  },
  recoverInterrupted: () => 0,
  catalog: () => catalogView(judgeCatalog("3", (name) => (name === "spec_relevance" ? "calibrated" : "experimental"))),
};

function deps(over: Partial<ApiDeps> = {}): ApiDeps {
  return {
    queue: { size: 0 },
    enqueue: () => "run-new",
    loadApp: (n) => {
      if (n === "demo") return { name: "demo", repo: "o/d", qa: { shadow: false, needsReview: true, testDataPrefix: "qa" } } as never;
      throw new AppNotFoundError(n);
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
  assert.deepEqual(json.scores.map((s: { name: string }) => s.name).slice(0, GRADER_CATALOG.length), GRADER_CATALOG.map((s) => s.name));
  const mix = json.scores.find((s: { name: string }) => s.name === "step_intent_mix");
  assert.deepEqual(mix.suffixes, ["auth", "explore", "write_spec", "run_spec", "review", "other"]);
  assert.equal(mix.polarity, "none");
});

test("GET /evaluations/catalog lists each judge after the graders with its prompt-versioned grader version and its calibration status; a grader has no status", async () => {
  const { json } = await call("GET", "/api/v1/evaluations/catalog");
  EvaluationCatalogSchema.parse(json);
  const byName = (name: string) => json.scores.find((s: { name: string }) => s.name === name);
  assert.equal(byName("spec_relevance").status, "calibrated");
  assert.equal(byName("failure_root_cause").status, "experimental");
  assert.equal(byName("spec_relevance").graderVersion, "judge-spec_relevance@3");
  assert.equal(byName("failure_root_cause").dataType, "CATEGORICAL");
  assert.ok(byName("failure_root_cause").categories.includes("selector"));
  assert.equal("status" in byName("spec_pass_rate"), false, "status is for judges only");
});

test("GET /runs/:id/evaluation carries a judge's score with its source, its prompt-versioned grader version and the model that answered", async () => {
  const judgedEvaluation: EvaluationService = {
    ...evaluation,
    evaluation: (id) => ({
      runId: id,
      traceId: null,
      status: "complete",
      scores: [
        { name: "spec_pass_rate", value: 0.5, dataType: "NUMERIC", polarity: "higher_better", source: "deterministic", graderVersion: "2" },
        { name: "spec_relevance", value: true, dataType: "BOOLEAN", polarity: "higher_better", source: "llm_judge", graderVersion: "judge-spec_relevance@3", comment: "opens the changed page", judgeModel: "prov/judge-model" },
      ],
    }),
  };
  const { json } = await call("GET", "/api/v1/runs/run-1/evaluation", undefined, deps({ evaluation: judgedEvaluation }));
  RunEvaluationSchema.parse(json);
  const judged = json.scores.find((s: { name: string }) => s.name === "spec_relevance");
  assert.equal(judged.source, "llm_judge");
  assert.equal(judged.judgeModel, "prov/judge-model");
  assert.equal(judged.graderVersion, "judge-spec_relevance@3");
  const grader = json.scores.find((s: { name: string }) => s.name === "spec_pass_rate");
  assert.equal("judgeModel" in grader, false);
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

test("GET /runs/:id carries the campaign and the effectiveConfig exactly in the contract's shape", async () => {
  const { json } = await call("GET", "/api/v1/runs/run-1");
  assert.deepEqual(json.campaign, { id: "ab-1", variant: { arm: "treatment" }, replicate: 2 });
  assert.deepEqual(Object.keys(json.effectiveConfig), ["levers", "campaignFreeze", "runtime", "agents", "prompt", "grounding", "coverage", "reflector"]);
  assert.deepEqual(json.effectiveConfig.levers, { closedLoop: true, agentBrowser: false, captureMode: "metadata" });
});

test("POST /runs hands the campaign and the requested capture mode to the enqueue, and nothing else of them", async () => {
  const seen: unknown[] = [];
  const d = deps({ enqueue: (...args) => { seen.push(args); return "run-new"; } });
  const campaign = { id: "ab-1", variant: { arm: "treatment", model: "m1" }, replicate: 2 };
  const ok = await call("POST", "/api/v1/runs", JSON.stringify({ app: "demo", sha: "abc1234", campaign, captureMode: "full" }), d);
  assert.equal(ok.status, 202);
  const args = seen[0] as unknown[];
  assert.deepEqual(args[11], { campaign, captureMode: "full" });
  await call("POST", "/api/v1/runs", JSON.stringify({ app: "demo", sha: "abc1234" }), d);
  assert.deepEqual((seen[1] as unknown[])[11], {});
});

test("POST /runs refuses a malformed campaign or capture mode with a 400 that carries schemaVersion", async () => {
  const bodies = [
    { campaign: { id: "bad id", variant: {}, replicate: 1 } },
    { campaign: { id: "ok", variant: { k: "v" }, replicate: 0 } },
    { campaign: { id: "ok", variant: { k: "v" } } },
    { campaign: "ab-1" },
    { captureMode: "everything" },
  ];
  for (const extra of bodies) {
    const { status, json } = await call("POST", "/api/v1/runs", JSON.stringify({ app: "demo", sha: "abc1234", ...extra }));
    assert.equal(status, 400, JSON.stringify(extra));
    assert.equal(json.schemaVersion, 1);
  }
});

test("GET /campaigns/:id/runs lists the runs, filters by variant labels and says whether the campaign is complete", async () => {
  const all = await call("GET", "/api/v1/campaigns/ab-1/runs");
  assert.equal(all.status, 200);
  CampaignRunsSchema.parse(all.json);
  assert.equal(all.json.campaignId, "ab-1");
  assert.equal(all.json.runs.length, 2);
  assert.equal(all.json.complete, false);
  const control = await call("GET", "/api/v1/campaigns/ab-1/runs?variant.arm=control");
  assert.deepEqual(control.json.runs.map((r: { id: string }) => r.id), ["run-1"]);
  assert.equal(control.json.complete, true);
});

test("GET /campaigns/:id/runs refuses a parameter that is not a variant filter", async () => {
  for (const q of ["?foo=bar", "?variant.=x", "?variant.a=1&variant.a=2"]) {
    const { status, json } = await call("GET", `/api/v1/campaigns/ab-1/runs${q}`);
    assert.equal(status, 400, q);
    assert.equal(json.schemaVersion, 1);
  }
});

test("GET /campaigns/:id/runs answers 400 with schemaVersion for an id that does not decode or is not a campaign id", async () => {
  for (const id of ["%zz", "bad%20id", "a%2Fb", "x".repeat(101), "%E0%A4%A"]) {
    const { status, json } = await call("GET", `/api/v1/campaigns/${id}/runs`);
    assert.equal(status, 400, id);
    assert.equal(json.schemaVersion, 1);
    assert.equal(typeof json.error, "string");
  }
  assert.equal((await call("GET", "/api/v1/campaigns/ab-1.x%3Ay/runs")).status, 200);
});

test("POST /runs answers 409 naming the campaign's capture mode when the run's applied mode differs", async () => {
  const { CampaignCaptureMismatchError } = await import("./campaign-capture");
  const d = deps({ enqueue: () => { throw new CampaignCaptureMismatchError("ab-1", "metadata", "full"); } });
  const { status, json } = await call("POST", "/api/v1/runs", JSON.stringify({ app: "demo", sha: "abc1234", campaign: { id: "ab-1", variant: {}, replicate: 1 }, captureMode: "full" }), d);
  assert.equal(status, 409);
  assert.equal(json.schemaVersion, 1);
  assert.match(json.error, /metadata/);
});
