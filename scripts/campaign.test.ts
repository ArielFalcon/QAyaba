import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { LoadedSnapshot } from "./warm-suite.ts";
import type { DeltaFile, SuiteDelta } from "./campaign-suite.ts";
import type { ProbeReport } from "./probe-metrics.ts";
import type { CampaignRecord } from "./campaign-report.ts";
import { campaignOf, cleanupRunOptions, judgeCleanup, noRetryConfig, runCampaign, type AppFacts, type ArmOutcome, type CampaignDeps, type PipelineRequest, type BaselineRequest, type ValidationRequest } from "./campaign.ts";

const SHA = "abc1234def";
const GOOD_SPEC = 'import { test, expect } from "@playwright/test";\ntest("refuses", async ({ page }) => {\n await page.goto("/x");\n await expect(page.getByRole("alert")).toBeVisible();\n});\n';
const FAKE_SPEC = 'import { test, expect } from "@playwright/test";\ntest("passes", async ({ page }) => {\n await page.goto("/x");\n expect(true).toBe(true);\n});\n';

const file = (path: string, text: string): DeltaFile => ({ path, bytes: Buffer.from(text) });

const casesFile = (over: Record<string, unknown> = {}) => ({
  app: "demo",
  cases: [{ id: "dup", kind: "diff", sha: SHA, expected: { outcome: "spec", mustVerify: "a duplicate is refused" }, ...over }],
});

function snapshot(login = "setup('authenticate', async () => {});\n", extra: string[] = []): LoadedSnapshot {
  const files = new Map<string, Buffer>([["auth.setup.ts", Buffer.from(login)], ...extra.map((p): [string, Buffer] => [p, Buffer.from("x")])]);
  return {
    label: "warm-1", dir: "/mirrors/.warm/demo/warm-1",
    manifest: { schema: 1, app: "demo", repo: "org/demo", label: "warm-1", createdAt: "2026-10-11T10:00:00.000Z", files: [...files.keys()].map((path) => ({ path, sha256: "0".repeat(64), bytes: 1 })), excluded: [] },
    files,
  };
}

function report(arm: "pipeline" | "baseline", verdict: RunVerdict, over: Partial<ProbeReport> = {}): ProbeReport {
  return {
    schema: 1, arm, id: "r", app: "demo", sha: SHA, mode: "diff", at: null, verdict, errorClass: null, note: null, finished: true, totalMs: 600_000,
    phases: { gate: null, classify: null, setup: null, grounding: null, generation: 300_000, validate: null, health: null, execute: null, coverage: 60_000, retry: null, decide: null },
    nested: { explorerMs: null, domCaptureMs: null, reviewMs: null },
    turns: [{ stepsUsed: 12 } as ProbeReport["turns"][number], { stepsUsed: 8 } as ProbeReport["turns"][number]],
    totals: { calls: 10, costUsd: 0.25, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, agentMs: 1, turnsWithPartialUsage: 0 },
    specs: [], execution: null, coverage: null, reviewer: null, ...over,
  };
}

const green = { verdict: "pass" as const, cases: [{ name: "a.spec.ts › refuses", status: "pass" }] };

interface Harness {
  deps: CampaignDeps;
  calls: string[];
  lines: string[];
  pipelineRequests: PipelineRequest[];
  baselineRequests: BaselineRequest[];
  validations: ValidationRequest[];
  written: Map<string, string>;
  saved: Map<string, DeltaFile[]>;
}

function harness(over: Partial<CampaignDeps> = {}, opts: { cases?: unknown; app?: Partial<AppFacts> } = {}): Harness {
  const calls: string[] = [];
  const lines: string[] = [];
  const pipelineRequests: PipelineRequest[] = [];
  const baselineRequests: BaselineRequest[] = [];
  const validations: ValidationRequest[] = [];
  const written = new Map<string, string>();
  const saved = new Map<string, DeltaFile[]>();
  const deps: CampaignDeps = {
    env: {},
    nowIso: () => "2026-10-12T10:00:00.000Z",
    out: (line) => lines.push(line),
    readCases: () => opts.cases ?? casesFile(),
    loadApp: (name) => ({ name, repo: "org/demo", baseUrl: "https://dev.example.test", testDataPrefix: "qa-bot", shadow: true, services: ["org/users-service"], ...opts.app }),
    loadWarmSnapshot: () => snapshot(),
    envFlags: () => ({ campaignFreeze: true }),
    campaignDir: (label) => `/campaigns/${label}`,
    campaignExists: () => false,
    commitsAvailable: async () => null,
    waitForIdleQueue: async () => { calls.push("idle"); },
    seedStore: async () => { calls.push("seed"); },
    runCleanup: async () => { calls.push("cleanup"); return { ok: true, note: "pass" }; },
    runPipeline: async (req): Promise<ArmOutcome> => {
      calls.push("run:B");
      pipelineRequests.push(req);
      return { report: report("pipeline", "pass"), runId: "run-1", capped: false, lost: false, wallMs: 650_000 };
    },
    runBaseline: async (req): Promise<ArmOutcome> => {
      calls.push("run:A");
      baselineRequests.push(req);
      return { report: report("baseline", "pass", { totalMs: 500_000, phases: { gate: null, classify: null, setup: 20_000, grounding: null, generation: 400_000, validate: null, health: null, execute: 80_000, coverage: null, retry: null, decide: null } }), runId: null, capped: false, lost: false, wallMs: 500_000 };
    },
    pipelineDelta: async (): Promise<SuiteDelta> => ({ files: [file("a.spec.ts", GOOD_SPEC)], removed: [], skipped: [] }),
    readSavedFiles: async () => [file("a.spec.ts", GOOD_SPEC)],
    saveFiles: (dir, files) => { saved.set(dir, [...files]); },
    validate: async (req) => { calls.push("validate"); validations.push(req); return { runs: [green, green] }; },
    writeJson: (path, value) => { written.set(path, JSON.stringify(value)); },
    writeText: (path, text) => { written.set(path, text); },
    ...over,
  };
  return { deps, calls, lines, pipelineRequests, baselineRequests, validations, written, saved };
}

const argv = (...extra: string[]): string[] => ["--cases", "cases.json", "--replicas", "1", "--label", "camp", "--warm", "warm-1", "--arms", "B", ...extra];

const recordOf = (h: Harness): CampaignRecord => JSON.parse(h.written.get("/campaigns/camp/campaign.json")!) as CampaignRecord;

/* ── before anything runs ── */

test("an app that is not in shadow mode stops the campaign before any arm runs, unless the operator says otherwise", async () => {
  const h = harness({}, { app: { shadow: false } });
  assert.equal(await runCampaign(argv(), h.deps), 1);
  assert.deepEqual(h.calls, []);
  assert.ok(h.lines.some((l) => l.includes("shadow")));
  const allowed = harness({}, { app: { shadow: false } });
  assert.equal(await runCampaign(argv("--allow-non-shadow"), allowed.deps), 0);
});

test("the pipeline arm is refused when learning is not frozen, unless the operator vouches for the server", async () => {
  const h = harness({ envFlags: () => ({ campaignFreeze: false }) });
  assert.equal(await runCampaign(argv(), h.deps), 1);
  assert.deepEqual(h.calls, []);
  assert.ok(h.lines.some((l) => l.includes("QA_CAMPAIGN_FREEZE")));
  const vouched = harness({ envFlags: () => ({ campaignFreeze: false }) });
  assert.equal(await runCampaign(argv("--skip-env-checks"), vouched.deps), 0);
});

test("the plain agent alone does not need the pipeline's switches", async () => {
  const h = harness({ envFlags: () => ({ campaignFreeze: false }) });
  assert.equal(await runCampaign(argv("--arms", "A"), h.deps), 0);
  assert.deepEqual(h.pipelineRequests, []);
});

test("a snapshot whose login was never authored is refused: the start would not be warm", async () => {
  const h = harness({ loadWarmSnapshot: () => snapshot("// qa-auth-setup-seed\n") });
  assert.equal(await runCampaign(argv(), h.deps), 1);
  assert.deepEqual(h.calls, []);
});

test("a cleanup spec the warm snapshot does not hold is refused before DEV is used", async () => {
  const h = harness({}, { cases: casesFile({ cleanup: { spec: "cleanup-addresses.spec.ts" } }) });
  assert.equal(await runCampaign(argv(), h.deps), 1);
  assert.ok(h.lines.some((l) => l.includes("cleanup-addresses.spec.ts")));
  const held = harness({ loadWarmSnapshot: () => snapshot(undefined, ["cleanup-addresses.spec.ts"]) }, { cases: casesFile({ cleanup: { spec: "cleanup-addresses.spec.ts" } }) });
  assert.equal(await runCampaign(argv(), held.deps), 0);
});

test("a cross-repo case for a service the app does not declare is refused", async () => {
  const cases = casesFile({ kind: "cross-repo", serviceRepo: "org/other-service" });
  const h = harness({}, { cases });
  assert.equal(await runCampaign(argv(), h.deps), 1);
  assert.ok(h.lines.some((l) => l.includes("org/other-service")));
});

test("a campaign directory that already exists is refused: a label names one campaign", async () => {
  const h = harness({ campaignExists: () => true });
  assert.equal(await runCampaign(argv(), h.deps), 1);
  assert.deepEqual(h.calls, []);
});

test("commits the plain agent cannot find in the mirrors stop the campaign with what to do about it", async () => {
  const h = harness({ commitsAvailable: async () => "commit abc is not in the mirror" });
  assert.equal(await runCampaign(argv("--arms", "A,B"), h.deps), 1);
  assert.ok(h.lines.some((l) => l.includes("not in the mirror")));
  const pipelineOnly = harness({ commitsAvailable: async () => "commit abc is not in the mirror" });
  assert.equal(await runCampaign(argv("--arms", "B"), pipelineOnly.deps), 0, "the pipeline fetches what it needs");
});

test("a dry run checks everything, prints the plan and runs nothing", async () => {
  const h = harness();
  assert.equal(await runCampaign(argv("--arms", "A,B", "--replicas", "2", "--dry-run"), h.deps), 0);
  assert.deepEqual(h.calls, []);
  const text = h.lines.join("\n");
  assert.ok(text.includes("dup"));
  assert.ok(text.includes("A -> B") && text.includes("B -> A"), "the order of the arms per replicate");
  assert.equal(h.written.size, 0, "a dry run writes no result");
});

/* ── the order of the runs ── */

test("the arms alternate by replicate, and everything is sequential", async () => {
  const h = harness();
  assert.equal(await runCampaign(argv("--arms", "A,B", "--replicas", "3"), h.deps), 0);
  assert.deepEqual(h.calls.filter((c) => c.startsWith("run:")), ["run:A", "run:B", "run:B", "run:A", "run:A", "run:B"]);
});

test("each arm-run waits for an idle queue, runs the case's cleanup, then seeds the warm snapshot into the suite store, before the arm starts", async () => {
  const h = harness({ loadWarmSnapshot: () => snapshot(undefined, ["cleanup-addresses.spec.ts"]) }, { cases: casesFile({ cleanup: { spec: "cleanup-addresses.spec.ts" } }) });
  assert.equal(await runCampaign(argv("--arms", "A,B"), h.deps), 0);
  const firstRun = h.calls.indexOf("run:A");
  assert.deepEqual(h.calls.slice(0, firstRun + 1), ["idle", "cleanup", "seed", "run:A"]);
  const second = h.calls.slice(firstRun + 1);
  assert.deepEqual(second.slice(second.indexOf("idle"), second.indexOf("run:B") + 1), ["idle", "cleanup", "seed", "run:B"]);
});

test("a case with no cleanup runs none", async () => {
  const h = harness();
  await runCampaign(argv(), h.deps);
  assert.equal(h.calls.includes("cleanup"), false);
});

test("the arm runs get the same wall cap, and the pipeline is always asked for shadow", async () => {
  const h = harness();
  assert.equal(await runCampaign(argv("--arms", "A,B", "--wall-cap-min", "7"), h.deps), 0);
  assert.equal(h.pipelineRequests[0]!.capMs, 7 * 60_000);
  assert.equal(h.pipelineRequests[0]!.shadow, true);
  assert.equal(h.baselineRequests[0]!.timeoutMin, 7);
  assert.equal(h.baselineRequests[0]!.warm, "warm-1");
});

test("the pipeline arm is sent as a replicate of the campaign: the label is the id, the arm and its levers the variant", async () => {
  const h = harness();
  assert.equal(await runCampaign(argv("--arms", "A,B", "--replicas", "2", "--closed-loop", "on"), h.deps), 0);
  assert.deepEqual(h.pipelineRequests.map((r) => r.campaign), [
    { id: "camp", variant: { arm: "B", closedLoop: "on", agentBrowser: "default", grounding: "default" }, replicate: 1 },
    { id: "camp", variant: { arm: "B", closedLoop: "on", agentBrowser: "default", grounding: "default" }, replicate: 2 },
  ]);
});

test("a label the service would refuse as a campaign id sends no campaign", () => {
  assert.equal(campaignOf({ label: "has space" }, "B", 1), undefined);
  assert.equal(campaignOf({ label: "x".repeat(101) }, "B", 1), undefined);
  assert.equal(campaignOf({ label: "ok.label-1" }, "B", 3)?.replicate, 3);
});

test("the plain agent keeps its files where the campaign will read them back, and a cross-repo case reaches both arms as the service's commit", async () => {
  const h = harness({}, { cases: casesFile({ kind: "cross-repo", serviceRepo: "org/users-service" }) });
  assert.equal(await runCampaign(argv("--arms", "A,B"), h.deps), 0);
  assert.equal(h.baselineRequests[0]!.serviceRepo, "org/users-service");
  assert.equal(h.pipelineRequests[0]!.serviceRepo, "org/users-service");
  assert.ok(h.baselineRequests[0]!.keepSpecsDir.startsWith("/campaigns/camp/dup/"));
});

/* ── what counts as delivered, and as valid ── */

test("the pipeline's specs count only when its run was accepted: a failed run's files are kept apart and never validated", async () => {
  const h = harness({ runPipeline: async () => ({ report: report("pipeline", "fail"), runId: "run-9", capped: false, lost: false, wallMs: 1 }) });
  assert.equal(await runCampaign(argv(), h.deps), 0);
  const r = recordOf(h).results[0]!;
  assert.deepEqual(r.delivered, []);
  assert.equal(r.valid, false);
  assert.equal(r.outcome, "none");
  assert.equal(h.validations.length, 0);
  assert.ok([...h.saved.keys()].some((dir) => dir.endsWith("/rejected")), "the rejected files are kept for reading");
});

test("a run the reviewer rejected is not accepted although its verdict is pass: its files are kept apart and never validated", async () => {
  const h = harness({ runPipeline: async () => ({ report: report("pipeline", "pass", { reviewer: { approved: false, reasons: ["asserts nothing"] } }), runId: "run-9", capped: false, lost: false, wallMs: 1 }) });
  assert.equal(await runCampaign(argv(), h.deps), 0);
  const r = recordOf(h).results[0]!;
  assert.deepEqual(r.delivered, []);
  assert.equal(r.outcome, "none");
  assert.equal(h.validations.length, 0);
  assert.ok([...h.saved.keys()].some((dir) => dir.endsWith("/rejected")), "the rejected files are kept for reading");
});

test("a run with no reviewer figure, or an approving one, is accepted", async () => {
  for (const reviewer of [null, { approved: true, reasons: [] }, { approved: null, reasons: [] }]) {
    const h = harness({ runPipeline: async () => ({ report: report("pipeline", "pass", { reviewer }), runId: "run-9", capped: false, lost: false, wallMs: 1 }) });
    assert.equal(await runCampaign(argv(), h.deps), 0);
    assert.deepEqual(recordOf(h).results[0]!.delivered, ["a.spec.ts"], JSON.stringify(reviewer));
  }
});

const FAILED_COVERAGE = { status: "fail" as const, ratio: 0.1, changedLines: 10, coveredLines: 1, minRatio: 0.7 };

test("a green run whose change-coverage blocks under the app's enforce policy is not accepted: its files are kept apart", async () => {
  const h = harness({ runPipeline: async () => ({ report: report("pipeline", "pass", { coverage: FAILED_COVERAGE }), runId: "run-9", capped: false, lost: false, wallMs: 1 }) }, { app: { coverageMode: "enforce" } });
  assert.equal(await runCampaign(argv(), h.deps), 0);
  const r = recordOf(h).results[0]!;
  assert.deepEqual(r.delivered, []);
  assert.equal(h.validations.length, 0);
  assert.ok([...h.saved.keys()].some((dir) => dir.endsWith("/rejected")));
});

test("a failed change-coverage never blocks under the signal policy, an unknown one never blocks under enforce", async () => {
  for (const [coverageMode, coverage] of [["signal", FAILED_COVERAGE], [undefined, FAILED_COVERAGE], ["enforce", { ...FAILED_COVERAGE, status: "unknown" as const, ratio: null }]] as const) {
    const h = harness({ runPipeline: async () => ({ report: report("pipeline", "pass", { coverage }), runId: "run-9", capped: false, lost: false, wallMs: 1 }) }, { app: coverageMode ? { coverageMode } : {} });
    assert.equal(await runCampaign(argv(), h.deps), 0);
    assert.deepEqual(recordOf(h).results[0]!.delivered, ["a.spec.ts"], `${coverageMode}/${coverage.status}`);
  }
});

test("a spec the pipeline accepted and that is green twice with no retry is valid and waits for the rubric", async () => {
  const h = harness();
  assert.equal(await runCampaign(argv(), h.deps), 0);
  const r = recordOf(h).results[0]!;
  assert.equal(r.valid, true);
  assert.equal(r.rubric, "pending");
  assert.deepEqual(r.delivered, ["a.spec.ts"]);
  assert.equal(h.validations[0]!.specs.length, 1);
  assert.ok(h.written.get("/campaigns/camp/rubric.csv")!.includes("a duplicate is refused"));
});

test("the plain agent's own green is not believed: a spec that fails the re-run is not valid", async () => {
  const red = { verdict: "fail" as const, cases: [{ name: "a.spec.ts › refuses", status: "fail" }] };
  const h = harness({ validate: async () => ({ runs: [green, red] }) });
  assert.equal(await runCampaign(argv("--arms", "A"), h.deps), 0);
  const r = recordOf(h).results[0]!;
  assert.equal(r.valid, false);
  assert.equal(r.rubric, "n/a");
  assert.equal(r.verdict, "pass", "the arm's own verdict is recorded as it was");
});

test("a fake pass is flagged, never valid, and never re-run", async () => {
  const h = harness({ readSavedFiles: async () => [file("a.spec.ts", FAKE_SPEC)] });
  assert.equal(await runCampaign(argv("--arms", "A"), h.deps), 0);
  const r = recordOf(h).results[0]!;
  assert.equal(r.valid, false);
  assert.ok(r.specs[0]!.flags.length > 0);
  assert.equal(h.validations.length, 0);
});

test("the files handed to the re-run include the helpers the specs import but not the pipeline's own state", async () => {
  const h = harness({
    pipelineDelta: async () => ({ files: [file("a.spec.ts", GOOD_SPEC), file("pages/alert.ts", "export {}"), file(".qa/manifest.json", "{}")], removed: [], skipped: [] }),
  });
  await runCampaign(argv(), h.deps);
  assert.deepEqual(h.validations[0]!.files.map((f) => f.path).sort(), ["a.spec.ts", "pages/alert.ts"]);
});

test("a declared no-op where a no-op is expected is a match with nothing to score", async () => {
  const h = harness(
    { runPipeline: async () => ({ report: report("pipeline", "skipped"), runId: "run-2", capped: false, lost: false, wallMs: 1 }), pipelineDelta: async () => ({ files: [], removed: [], skipped: [] }) },
    { cases: casesFile({ expected: { outcome: "noop", mustVerify: "nothing" } }) },
  );
  assert.equal(await runCampaign(argv(), h.deps), 0);
  const r = recordOf(h).results[0]!;
  assert.equal(r.outcome, "noop");
  assert.equal(r.matchesExpected, true);
  assert.equal(r.valid, false);
  assert.equal(r.rubric, "n/a");
});

test("specs delivered where a no-op was expected do not match the case", async () => {
  const h = harness({}, { cases: casesFile({ expected: { outcome: "noop", mustVerify: "nothing" } }) });
  await runCampaign(argv(), h.deps);
  assert.equal(recordOf(h).results[0]!.matchesExpected, false);
});

/* ── a replicate that cannot be compared ── */

test("a run cut by the wall cap is marked invalid and its files are not validated", async () => {
  const h = harness({ runPipeline: async () => ({ report: report("pipeline", "infra-error", { errorClass: "E-CANCELLED" }), runId: "run-3", capped: true, lost: false, wallMs: 1_800_000 }) });
  assert.equal(await runCampaign(argv(), h.deps), 0);
  const r = recordOf(h).results[0]!;
  assert.equal(r.invalidReplicate, true);
  assert.equal(r.capped, true);
  assert.equal(h.validations.length, 0);
});

test("a run that was lost, and a failed cleanup, mark the replicate invalid without stopping the campaign", async () => {
  const lost = harness({ runPipeline: async () => ({ report: null, runId: null, capped: false, lost: true, error: "could not start", wallMs: 5 }) });
  assert.equal(await runCampaign(argv("--replicas", "2"), lost.deps), 0);
  assert.deepEqual(recordOf(lost).results.map((r) => r.invalidReplicate), [true, true]);

  const dirty = harness({ loadWarmSnapshot: () => snapshot(undefined, ["cleanup.spec.ts"]), runCleanup: async () => ({ ok: false, note: "fail" }) }, { cases: casesFile({ cleanup: { spec: "cleanup.spec.ts" } }) });
  assert.equal(await runCampaign(argv(), dirty.deps), 0);
  assert.equal(recordOf(dirty).results[0]!.invalidReplicate, true);
});

test("a re-run that could not execute marks the replicate invalid rather than the spec bad", async () => {
  const h = harness({ validate: async () => ({ runs: [], error: "DEV did not answer" }) });
  await runCampaign(argv(), h.deps);
  const r = recordOf(h).results[0]!;
  assert.equal(r.invalidReplicate, true);
  assert.equal(r.valid, false);
});

test("a queue that never goes idle stops the campaign, and what was finished is still written", async () => {
  let n = 0;
  const h = harness({ waitForIdleQueue: async () => { n += 1; if (n === 2) throw new Error("the queue is busy"); } });
  assert.equal(await runCampaign(argv("--replicas", "3"), h.deps), 1);
  const record = recordOf(h);
  assert.equal(record.complete, false);
  assert.equal(record.results.length, 1);
  assert.ok(h.lines.some((l) => l.includes("the queue is busy")));
});

/* ── what is measured and written ── */

test("cost, steps and wall time come from the arm's own report, the wall without the change-coverage phase where the oracle runs", async () => {
  const h = harness();
  await runCampaign(argv("--arms", "A,B"), h.deps);
  const [a, b] = recordOf(h).results;
  assert.equal(a!.arm, "A");
  assert.equal(a!.costUsd, 0.25);
  assert.equal(a!.steps, 20);
  assert.equal(a!.wallMs, 500_000);
  assert.equal(a!.wallExclOracleMs, 500_000, "the plain agent has no oracle phase");
  assert.equal(b!.wallMs, 600_000);
  assert.equal(b!.wallExclOracleMs, 540_000);
  assert.equal(b!.start, "warm");
});

test("a figure the arm did not report is unknown, not zero", async () => {
  const h = harness({ runPipeline: async () => ({ report: report("pipeline", "pass", { totals: { calls: null, costUsd: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, agentMs: null, turnsWithPartialUsage: 0 }, turns: [{ stepsUsed: null } as ProbeReport["turns"][number]] }), runId: "r", capped: false, lost: false, wallMs: 1 }) });
  await runCampaign(argv(), h.deps);
  const r = recordOf(h).results[0]!;
  assert.equal(r.costUsd, null);
  assert.equal(r.steps, null);
});

test("every arm-run is written as it finishes, with the files the arm delivered under its own directory, and the campaign files beside them", async () => {
  const h = harness();
  assert.equal(await runCampaign(argv("--arms", "A,B"), h.deps), 0);
  assert.ok(h.written.has("/campaigns/camp/campaign.json"));
  assert.ok(h.written.has("/campaigns/camp/campaign.md"));
  assert.ok(h.written.has("/campaigns/camp/rubric.csv"));
  assert.ok(h.written.has("/campaigns/camp/dup/B-1/result.json"));
  assert.ok(h.saved.has("/campaigns/camp/dup/B-1/files"));
  assert.equal(recordOf(h).complete, true);
});

/* ── the re-run's Playwright config ── */

test("the re-run's config is the repo's own with the retries turned off, so a spec passes only when it passes the first time", () => {
  const config = noRetryConfig();
  assert.ok(config.includes("retries: 0"));
  assert.ok(config.includes("playwright.repo.config"), "wraps the repo's config rather than replacing it");
});

test("the cleanup pass is run on the app's data prefix as a cleanup pass, not under a namespace of its own", () => {
  const app: AppFacts = { name: "demo", repo: "org/demo", baseUrl: "https://dev.example.test", testDataPrefix: "qa-bot", shadow: true, services: [] };

  const options = cleanupRunOptions(app, "cleanup-addresses.spec.ts");

  assert.equal(options.cleanupPass, true);
  assert.equal(options.namespace, app.testDataPrefix);
  assert.deepEqual(options.specFiles, ["cleanup-addresses.spec.ts"]);
  assert.equal(options.baseUrl, app.baseUrl);
});

test("the cleanup pass carries the app's test id attribute when it declares one", () => {
  const app: AppFacts = { name: "demo", repo: "org/demo", baseUrl: "https://dev.example.test", testDataPrefix: "qa-bot", shadow: true, services: [], testIdAttribute: "data-qa" };

  assert.equal(cleanupRunOptions(app, "cleanup.spec.ts").testIdAttribute, "data-qa");
});

test("a cleanup whose test passed is ok", () => {
  assert.equal(judgeCleanup({ verdict: "pass", cases: [{ name: "cleanup.spec.ts › cleanup", status: "pass" }] }).ok, true);
});

test("a cleanup whose only test was skipped did nothing and is not ok", () => {
  /* The runner drops a skipped test from the cases; a suite that executed nothing is an infra-error. */
  const outcome = judgeCleanup({ verdict: "infra-error", cases: [] });

  assert.equal(outcome.ok, false);
  assert.match(outcome.note, /did not run|skipped/i);
});

test("a cleanup that reports a pass without any passed test is not ok", () => {
  assert.equal(judgeCleanup({ verdict: "pass", cases: [] }).ok, false);
});

test("a cleanup that failed is not ok and its note carries the verdict", () => {
  const outcome = judgeCleanup({ verdict: "fail", cases: [{ name: "cleanup.spec.ts › cleanup", status: "fail" }] });

  assert.equal(outcome.ok, false);
  assert.match(outcome.note, /fail/);
});

/* ── arm A': the plain agent, its delivery judged by the acceptance ── */

const accepted = (over: Record<string, unknown> = {}) => ({ validate: { ok: true, infra: false, errors: [] }, runs: [], verdict: "pass", coverage: null, reviewer: null, decision: { verdict: "pass", sideEffect: "pr" }, accepted: true, ...over });
const baselineReportWith = (acceptance?: unknown): ProbeReport => report("baseline", "pass", acceptance === undefined ? {} : { detail: { acceptance } });
const armsAAprimeB = (...extra: string[]): string[] => ["--cases", "cases.json", "--replicas", "1", "--label", "camp", "--warm", "warm-1", "--arms", "A,A',B", ...extra];

test("--arms takes A' beside A and B, and by default the campaign still runs A and B only", async () => {
  const withPrime = harness();
  assert.equal(await runCampaign(armsAAprimeB(), withPrime.deps), 0);
  assert.deepEqual(recordOf(withPrime).args.arms, ["A", "A'", "B"]);

  const byDefault = harness();
  assert.equal(await runCampaign(["--cases", "cases.json", "--replicas", "1", "--label", "camp", "--warm", "warm-1"], byDefault.deps), 0);
  assert.deepEqual(recordOf(byDefault).args.arms, ["A", "B"]);
});

test("A' runs the plain agent asked to accept, with a label and a directory that can name a path, and A does not", async () => {
  const h = harness();
  await runCampaign(armsAAprimeB(), h.deps);
  const [plain, prime] = h.baselineRequests;
  assert.equal(plain!.accept, undefined, "arm A is unchanged");
  assert.equal(prime!.accept, true);
  assert.match(prime!.label, /^camp-dup-[A-Za-z0-9]+1$/);
  assert.doesNotMatch(prime!.label, /'/);
  assert.notEqual(plain!.label, prime!.label);
  assert.ok([...h.saved.keys()].some((dir) => dir.includes("dup/Ap-1") || dir.includes("Ap-1")), "its files are kept under a directory of their own");
});

test("A' asks for the reviewer's judgment exactly when the app requires one of the pipeline", async () => {
  const requires = harness({}, { app: { needsReview: true } });
  await runCampaign(armsAAprimeB(), requires.deps);
  assert.equal(requires.baselineRequests.find((r) => r.accept)!.acceptReview, true);
  const doesNot = harness({}, { app: { needsReview: false } });
  await runCampaign(armsAAprimeB(), doesNot.deps);
  assert.equal(doesNot.baselineRequests.find((r) => r.accept)!.acceptReview, undefined);
});

test("A' counts a delivery only when its acceptance accepted it, like the pipeline's run: otherwise the files are kept apart and never validated", async () => {
  const rejected = harness({
    runBaseline: async (req): Promise<ArmOutcome> => ({ report: baselineReportWith(accepted({ accepted: false, verdict: "flaky", decision: { verdict: "flaky", sideEffect: "quarantine" } })), runId: null, capped: false, lost: false, wallMs: 1, ...(req.accept ? {} : {}) }),
  });
  await runCampaign(["--cases", "cases.json", "--replicas", "1", "--label", "camp", "--warm", "warm-1", "--arms", "A'"], rejected.deps);
  assert.equal(rejected.validations.length, 0);
  const result = recordOf(rejected).results[0]!;
  assert.deepEqual(result.delivered, []);
  assert.equal(result.valid, false);
  assert.ok([...rejected.saved.keys()].some((dir) => dir.endsWith("/rejected")), "what was delivered is kept apart");
});

test("A' with an accepting acceptance is judged like any other arm: its files are re-run and, if green twice, valid", async () => {
  const h = harness({
    runBaseline: async (): Promise<ArmOutcome> => ({ report: baselineReportWith(accepted()), runId: null, capped: false, lost: false, wallMs: 1 }),
  });
  await runCampaign(["--cases", "cases.json", "--replicas", "1", "--label", "camp", "--warm", "warm-1", "--arms", "A'"], h.deps);
  assert.equal(h.validations.length, 1);
  assert.equal(recordOf(h).results[0]!.valid, true);
});

test("A' with a report that carries no acceptance is not accepted: an arm asked to accept that did not is a failed arm-run", async () => {
  const h = harness({
    runBaseline: async (): Promise<ArmOutcome> => ({ report: baselineReportWith(undefined), runId: null, capped: false, lost: false, wallMs: 1 }),
  });
  await runCampaign(["--cases", "cases.json", "--replicas", "1", "--label", "camp", "--warm", "warm-1", "--arms", "A'"], h.deps);
  assert.equal(h.validations.length, 0);
  assert.equal(recordOf(h).results[0]!.valid, false);
});

test("--closed-loop on|off is the pipeline arm's own choice about the run_spec loop and is recorded; absent, the app's setting decides", async () => {
  const on = harness();
  await runCampaign(argv("--closed-loop", "on"), on.deps);
  assert.equal(on.pipelineRequests[0]!.closedLoop, true);
  assert.equal(recordOf(on).args.closedLoop, true);
  const off = harness();
  await runCampaign(argv("--closed-loop", "off"), off.deps);
  assert.equal(off.pipelineRequests[0]!.closedLoop, false);
  const none = harness();
  await runCampaign(argv(), none.deps);
  assert.equal("closedLoop" in none.pipelineRequests[0]!, false);
  const bad = harness();
  assert.equal(await runCampaign(argv("--closed-loop", "maybe"), bad.deps), 2);
});

test("--agent-browser on|off is the pipeline arm's own choice about the authenticated agent browser and is recorded; absent, the app's setting decides", async () => {
  const on = harness();
  await runCampaign(argv("--agent-browser", "on"), on.deps);
  assert.equal(on.pipelineRequests[0]!.agentBrowser, true);
  assert.equal(recordOf(on).args.agentBrowser, true);
  const off = harness();
  await runCampaign(argv("--agent-browser", "off"), off.deps);
  assert.equal(off.pipelineRequests[0]!.agentBrowser, false);
  const none = harness();
  await runCampaign(argv(), none.deps);
  assert.equal("agentBrowser" in none.pipelineRequests[0]!, false);
  const bad = harness();
  assert.equal(await runCampaign(argv("--agent-browser", "maybe"), bad.deps), 2);
});

