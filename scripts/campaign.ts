/*
 * The campaign runner of the pipeline-vs-plain-agent experiment. EXPERIMENT ONLY: nothing in the service calls this.
 *
 *   npm run campaign -- --cases <cases.json> --replicas <n> --label <l> --warm <snapshot-label>
 *                       [--arms A,B] [--wall-cap-min <m>] [--allow-non-shadow] [--skip-env-checks]
 *                       [--dry-run]
 *
 * Arm A is the plain agent (scripts/baseline-agent.ts), arm B the pipeline (the service's API, or its webhook for a
 * cross-repo case). The campaign runs every case of the cases file `--replicas` times for each arm, ONE run at a time against
 * DEV, the arms alternating order by replicate (AB, BA, ...). Before EACH arm-run it waits for an idle queue, runs the case's
 * cleanup (when declared) and seeds the warm snapshot into the app's suite store (scripts/warm-suite.ts seed-store), which the
 * pipeline restores after its checkout; the plain agent applies the same snapshot to its throwaway copy. Both arms get the same wall cap.
 *
 * What an arm "passed" is not taken from the arm. The files it delivered are saved under
 * config/benchmarks/campaigns/<label>/<case>/<arm>-<n>/ and re-run here twice with no retry against DEV, with the warm login;
 * a spec that looks fake (scripts/fake-pass-detector.ts) is never valid. The pipeline's files count only when its run was
 * accepted (verdict pass or flaky, the reviewer did not reject it, and the app's change-coverage policy does not block it): after a
 * reviewer rejection it accepts regenerated specs that never ran, and a rejected run's files are kept apart. The result is a JSON, a markdown table and a rubric.csv of the valid candidates for the owner
 * to score 0-3 (scripts/campaign-report.ts).
 *
 * Run it inside the orchestrator container.
 */
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { GroundingInput } from "@kernel/contract/commands.ts";
import { CAMPAIGN_ID_PATTERN, type CampaignIdentity } from "@kernel/campaign.ts";
import { EXPERIMENT_COPIES_DIR, WARM_SNAPSHOTS_DIR } from "../src/paths.ts";
import { DecideCoverageService } from "@contexts/objective-signal/domain/decide-coverage.service.ts";
import { detectFakeSpec } from "./fake-pass-detector.ts";
import {
  ARM, CASE_KIND, armOrder, armToken, assessSpecs, isPlainAgentArm, classifyOutcome, invalidReplicateReasons, matchesExpected, parseArguments, parseCases,
  type Arm, type CampaignArguments, type CampaignCase, type ValidationRunSummary,
} from "./campaign-model.ts";
import { renderMarkdown, renderRubricCsv, type ArmRunResult, type CampaignRecord } from "./campaign-report.ts";
import { specsOf, type DeltaFile, type SuiteDelta } from "./campaign-suite.ts";
import type { ProbeReport } from "./probe-metrics.ts";
import { type LoadedSnapshot, warmStatus } from "./warm-suite.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where campaigns are written (gitignored). */
export function defaultCampaignsDir(): string {
  return join(ROOT, "config", "benchmarks", "campaigns");
}

/* ── the wrapper around the repo's Playwright config ───────────────────────────────── */

export const REPO_CONFIG_COPY = "playwright.repo.config.ts";
export const CONFIG_FILE = "playwright.config.ts";
const IDLE_WAIT_MS = 5 * 60_000;
const AFTER_CAP_WAIT_MS = 3 * 60_000;
/** The system state the pipeline keeps beside the specs; not part of what an arm delivers. */
const SYSTEM_STATE_DIR = ".qa";

/** The repo's own Playwright config with the retries turned off: a spec passes the re-run only when it passes the first time. */
export function noRetryConfig(): string {
  return [
    "// campaign harness (experiment only): the repo's own config, unchanged, with no retry, so a spec passes only when it passes the first time.",
    'import { defineConfig } from "@playwright/test";',
    `import base from "./${REPO_CONFIG_COPY.replace(/\.ts$/, "")}";`,
    "export default defineConfig(base, { retries: 0 });",
    "",
  ].join("\n");
}

/* ── collaborators ─────────────────────────────────────────────────────────────────── */

/** What the cleanup pass runs with: the app's BASE data prefix as the namespace (every arm's data starts with it: the pipeline's runs, the plain agent's `<prefix>-<sha7>-<label>` and the re-runs), and the cleanup flag the seed's cleanup spec needs to do anything. */
export function cleanupRunOptions(app: AppFacts, spec: string): { baseUrl: string; namespace: string; specFiles: string[]; cleanupPass: true; testIdAttribute?: string } {
  return { baseUrl: app.baseUrl, namespace: app.testDataPrefix, specFiles: [spec], cleanupPass: true, ...(app.testIdAttribute !== undefined ? { testIdAttribute: app.testIdAttribute } : {}) };
}

/** A cleanup is ok only when its test ran and passed. A skipped test is dropped from the cases (and a suite that executed nothing is an infra-error), so a cleanup that did nothing is never ok. */
export function judgeCleanup(run: { verdict: RunVerdict; cases: ReadonlyArray<{ name: string; status: string }> }): { ok: boolean; note: string } {
  const passed = run.cases.some((c) => c.status === "pass");
  if (run.verdict === "pass" && passed) return { ok: true, note: run.verdict };
  if (run.cases.length === 0) return { ok: false, note: `${run.verdict}: the cleanup test did not run (skipped, or no result), so it cleaned nothing` };
  return { ok: false, note: run.verdict };
}

/** What the campaign needs to know of the app, from its config. */
export interface AppFacts {
  name: string;
  repo: string;
  baseUrl: string;
  testDataPrefix: string;
  /** `qa.shadow` of its config. */
  shadow: boolean;
  /** `qa.changeCoverage.mode` of its config; absent is `signal`, the engine's default. */
  coverageMode?: "off" | "signal" | "enforce";
  /** `qa.needsReview` of its config: the pipeline keeps a suite only when an independent reviewer approved it. */
  needsReview?: boolean;
  /** The repos of the backend services it declares. */
  services: string[];
  testIdAttribute?: string;
}

export interface PipelineRequest {
  app: string;
  kind: CampaignCase["kind"];
  sha: string;
  serviceRepo?: string;
  /** The pipeline arm is always asked for shadow (a diff run carries it in its request). */
  shadow: true;
  capMs: number;
  groundTruthPath?: string;
  /** The run's own choice about the run_spec loop (an A/B), overriding the app's setting; absent: the app's setting decides. */
  closedLoop?: boolean;
  /** The run's own choice about the authenticated agent browser (an A/B), overriding the app's setting; absent: the app's setting decides. */
  agentBrowser?: boolean;
  /** The run's own choice of grounding sources (an A/B), overriding the app's settings; absent: the app decides. */
  grounding?: GroundingInput;
  /** The campaign replicate this run is, sent with the request so the service stores it on the run. Labels only: they change nothing the run does. */
  campaign?: CampaignIdentity;
}

export interface BaselineRequest {
  app: string;
  kind: CampaignCase["kind"];
  sha: string;
  serviceRepo?: string;
  label: string;
  timeoutMin: number;
  warm: string;
  /** Where the plain agent copies the files it delivered, before its throwaway copy is removed. */
  keepSpecsDir: string;
  groundTruthPath?: string;
  /** Arm A': the delivery is judged by the acceptance (validate, two runs with no retry, coverage), in place of the agent's own two runs. */
  accept?: boolean;
  /** With `accept`: the independent reviewer is asked too, as for an app that requires a review. */
  acceptReview?: boolean;
}

/** What an arm-run left: the arm's own report (null when it could not be made) and how the run ended. */
export interface ArmOutcome {
  report: ProbeReport | null;
  /** The pipeline's run id; null for the plain agent. */
  runId: string | null;
  /** The wall cap cut the run. */
  capped: boolean;
  /** The run could not be started, found or finished. */
  lost: boolean;
  error?: string;
  /** Measured by the campaign, from the start of the arm-run to its end. */
  wallMs: number | null;
}

export interface ValidationRequest {
  /** A directory name under the experiment area where the re-run's suite is built; the same for the whole campaign. */
  workspace: string;
  app: AppFacts;
  snapshot: LoadedSnapshot;
  /** Every file the arm delivered (specs and helpers). */
  files: DeltaFile[];
  /** The specs to execute. */
  specs: string[];
  /** Makes the re-run's data namespace unique. */
  namespaceSeed: string;
}

export interface ValidationOutcome {
  runs: ValidationRunSummary[];
  /** Set when the re-run could not be made at all. */
  error?: string;
}

export interface CampaignDeps {
  env: Record<string, string | undefined>;
  nowIso(): string;
  out(line: string): void;
  /** The parsed JSON of the cases file; throws when it cannot be read. */
  readCases(path: string): unknown;
  loadApp(name: string): AppFacts;
  /** The warm snapshot, whole and checked; throws when there is none. */
  loadWarmSnapshot(app: string, label: string): LoadedSnapshot;
  /** What this process sees of the switches the pipeline arm depends on. */
  envFlags(): { campaignFreeze: boolean };
  campaignDir(label: string): string;
  campaignExists(label: string): boolean;
  /** A problem text when the plain agent could not read the case's commits from the mirrors, null when it can. */
  commitsAvailable(app: AppFacts, c: CampaignCase): Promise<string | null>;
  /** Waits for the queue to be idle (nothing running, nothing pending); throws when it is not by then. */
  waitForIdleQueue(timeoutMs: number): Promise<void>;
  /** Loads the snapshot into the app's suite store, replacing what it held: the pipeline's next run restores it after its checkout. */
  seedStore(app: AppFacts, snapshot: LoadedSnapshot): Promise<void>;
  runCleanup(input: { app: AppFacts; snapshot: LoadedSnapshot; spec: string; workspace: string }): Promise<{ ok: boolean; note: string }>;
  runPipeline(req: PipelineRequest): Promise<ArmOutcome>;
  runBaseline(req: BaselineRequest): Promise<ArmOutcome>;
  /** What the pipeline left in the mirror's suite directory, against the snapshot it was restored to. */
  pipelineDelta(app: AppFacts, snapshot: LoadedSnapshot): Promise<SuiteDelta>;
  /** The files the plain agent kept in `dir`; empty when there are none. */
  readSavedFiles(dir: string): Promise<DeltaFile[]>;
  saveFiles(dir: string, files: readonly DeltaFile[]): void;
  validate(req: ValidationRequest): Promise<ValidationOutcome>;
  writeJson(path: string, value: unknown): void;
  writeText(path: string, text: string): void;
}

/* ── the run ───────────────────────────────────────────────────────────────────────── */

const USAGE = [
  "usage: npm run campaign -- --cases <cases.json> --replicas <n> --label <l> --warm <snapshot-label> [--arms A,B] [--wall-cap-min <m>] [--closed-loop on|off] [--agent-browser on|off]",
  "                           [--allow-non-shadow] [--skip-env-checks] [--dry-run]",
  "  EXPERIMENT ONLY. Runs every case --replicas times per arm (A: the plain agent, B: the pipeline), one run at a time against DEV, the arms",
  "  alternating order by replicate. Before each arm-run: idle queue, the case's cleanup, the warm snapshot seeded into the suite store. Delivered files are saved and",
  "  re-run twice without retry; fake-looking specs are never valid. Writes config/benchmarks/campaigns/<label>/{campaign.json,campaign.md,rubric.csv}.",
  "  --arms               a comma-separated list of A (the plain agent), A' (the plain agent, its delivery judged by the pipeline's acceptance) and B (the pipeline); default A,B",
  "  --wall-cap-min       wall cap per arm-run, equal for every arm (default 30)",
  "  --closed-loop        the pipeline arm's own choice about the run_spec loop, for an A/B of the loop (a diff case only: a cross-repo case enters through the webhook, which cannot carry it)",
  "  --agent-browser      the pipeline arm's own choice about the authenticated agent browser, for an A/B of the tools (a diff case only, like --closed-loop)",
  "  --grounding          comma-separated stitcher|structuralSignal|curriculum=on|off, for an A/B of grounding sources (reuse the campaign label across invocations to compare variants)",
  "  --allow-non-shadow   run the pipeline on an app whose config is not shadow (a webhook cannot ask for shadow)",
  "  --skip-env-checks    do not require QA_CAMPAIGN_FREEZE in this process (the server was started with it another way)",
  "  --dry-run            check everything and print the plan; run nothing",
  "run inside the orchestrator container.",
].join("\n");

const sum = (values: ReadonlyArray<number | null>): number | null => {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
};

const isAccepted = (verdict: RunVerdict | null): boolean => verdict === "pass" || verdict === "flaky";

/**
 * Whether the pipeline would have published this run: a pass or flaky verdict that the reviewer did not reject (no reviewer figure is not a
 * rejection) and that the app's change-coverage policy does not block (only `enforce` blocks, and only a failed measurement).
 */
function pipelineAccepted(report: ProbeReport | null, app: AppFacts): boolean {
  if (!isAccepted((report?.verdict ?? null) as RunVerdict | null)) return false;
  if (report?.reviewer?.approved === false) return false;
  const coverage = report?.coverage;
  return !(coverage && new DecideCoverageService().blocks(coverage.status, { mode: app.coverageMode ?? "signal", minRatio: coverage.minRatio }));
}

/** Whether the plain agent's acceptance (baseline-agent --accept, `detail.acceptance`) accepted its delivery; a report without one did not. */
function acceptanceAccepted(report: ProbeReport | null): boolean {
  const acceptance = report?.detail?.acceptance as { accepted?: unknown } | undefined;
  return acceptance?.accepted === true;
}

interface Plan {
  args: CampaignArguments;
  app: AppFacts;
  cases: CampaignCase[];
  snapshot: LoadedSnapshot;
  dir: string;
  workspace: string;
}

/** Everything that can be known before DEV is touched. Returns the problems found, all of them, so the operator fixes them in one go. */
async function preflight(args: CampaignArguments, plan: Omit<Plan, "args" | "dir" | "workspace">, deps: CampaignDeps): Promise<string[]> {
  const problems: string[] = [];
  const { app, cases, snapshot } = plan;
  if (!app.shadow) {
    const msg = `app '${app.name}' is not in shadow mode (qa.shadow): a pipeline run would open PRs and Issues. A diff case is asked for shadow in its request; a cross-repo case cannot be.`;
    if (!args.allowNonShadow) problems.push(`${msg} Put the app in shadow mode, or pass --allow-non-shadow.`);
  }
  if (args.arms.includes(ARM.PIPELINE) && !args.skipEnvChecks) {
    const flags = deps.envFlags();
    if (!flags.campaignFreeze) problems.push("QA_CAMPAIGN_FREEZE is not on in this process: the pipeline would learn from each replicate. Set it on the orchestrator and restart it (or pass --skip-env-checks if the server has it by another route).");
  }
  const status = warmStatus(snapshot);
  if (!status.warm) problems.push(`warm snapshot '${snapshot.label}' is not warm: ${status.note}`);
  for (const c of cases) {
    if (c.kind === CASE_KIND.CROSS_REPO && !app.services.includes(c.serviceRepo!)) {
      problems.push(`case '${c.id}': ${c.serviceRepo} is not a declared service of app '${app.name}' (declared: ${app.services.join(", ") || "none"})`);
    }
    if (c.cleanup && !snapshot.files.has(c.cleanup.spec)) problems.push(`case '${c.id}': cleanup spec ${c.cleanup.spec} is not in warm snapshot '${snapshot.label}'`);
    if (args.arms.some(isPlainAgentArm)) {
      const missing = await deps.commitsAvailable(app, c);
      if (missing !== null) problems.push(`case '${c.id}': ${missing} (the plain agent never fetches: run the pipeline arm once on the case first, e.g. --arms B --replicas 1)`);
    }
  }
  if (deps.campaignExists(args.label)) problems.push(`campaign '${args.label}' already exists: a label names one campaign, pick another or remove the directory`);
  return problems;
}

/** Returns the process exit code: 0 ok, 1 refused or stopped, 2 bad usage. */
export async function runCampaign(argv: string[], deps: CampaignDeps): Promise<number> {
  const out = deps.out;
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    out(parsed.problem);
    for (const line of USAGE.split("\n")) out(line);
    return 2;
  }
  const args = parsed.args;
  let record: CampaignRecord | undefined;
  let dir = "";
  try {
    const cases = parseCases(deps.readCases(args.casesPath));
    const app = deps.loadApp(cases.app);
    const snapshot = deps.loadWarmSnapshot(app.name, args.warm);
    const problems = await preflight(args, { app, cases: cases.cases, snapshot }, deps);
    if (problems.length > 0) {
      for (const p of problems) out(`error: ${p}`);
      return 1;
    }
    const plan: Plan = { args, app, cases: cases.cases, snapshot, dir: deps.campaignDir(args.label), workspace: `campaign-${args.label}` };
    dir = plan.dir;

    out(`[campaign] ${args.label}: app ${app.name}, ${cases.cases.length} case(s) x ${args.replicas} replicate(s) x arm(s) ${args.arms.join(",")}, wall cap ${args.wallCapMin} min, warm snapshot ${snapshot.label}`);
    for (const c of cases.cases) out(`[campaign] case ${c.id}: ${c.kind} ${c.sha.slice(0, 7)}${c.serviceRepo ? ` of ${c.serviceRepo}` : ""}, expects ${c.expected.outcome}${c.cleanup ? `, cleanup ${c.cleanup.spec}` : ""}`);
    for (let rep = 1; rep <= args.replicas; rep++) out(`[campaign] replicate ${rep}: ${armOrder(rep, args.arms).join(" -> ")}`);
    if (args.dryRun) {
      out("[campaign] dry run: nothing was started");
      return 0;
    }

    record = {
      schema: 1, label: args.label, app: app.name, startedAt: deps.nowIso(), finishedAt: null, complete: false,
      args: { replicas: args.replicas, arms: args.arms, wallCapMin: args.wallCapMin, warm: args.warm, casesPath: args.casesPath, ...(args.closedLoop !== undefined ? { closedLoop: args.closedLoop } : {}), ...(args.agentBrowser !== undefined ? { agentBrowser: args.agentBrowser } : {}) },
      environment: {
        campaignFreeze: deps.envFlags().campaignFreeze,
        appShadow: app.shadow, forcedShadow: args.arms.includes(ARM.PIPELINE),
      },
      snapshot: { label: snapshot.label, createdAt: snapshot.manifest.createdAt, warm: true },
      cases: cases.cases.map((c) => ({ id: c.id, kind: c.kind, sha: c.sha, expected: c.expected })),
      results: [],
    };
    const write = (): void => writeOutputs(deps, dir, record!);
    write();

    for (let rep = 1; rep <= args.replicas; rep++) {
      for (const c of cases.cases) {
        const order = armOrder(rep, args.arms);
        for (let i = 0; i < order.length; i++) {
          const result = await armRun(plan, deps, c, order[i]!, rep, i + 1);
          record.results.push(result);
          write();
          out(`[campaign] ${c.id} ${result.arm}${rep}: ${result.verdict ?? "no verdict"}, ${result.outcome}, valid ${result.valid ? "yes" : "no"}${result.invalidReplicate ? `, INVALID (${result.invalidReasons.join("; ")})` : ""}`);
        }
      }
    }
    record.complete = true;
    record.finishedAt = deps.nowIso();
    write();
    out(`[campaign] finished: ${dir}`);
    return 0;
  } catch (err) {
    out(`error: ${err instanceof Error ? err.message : String(err)}`);
    if (record) {
      record.finishedAt = deps.nowIso();
      try {
        writeOutputs(deps, dir, record);
        out(`[campaign] stopped early; what finished is in ${dir}`);
      } catch (writeErr) {
        out(`error: the partial result could not be written: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
      }
    }
    return 1;
  }
}

function writeOutputs(deps: CampaignDeps, dir: string, record: CampaignRecord): void {
  deps.writeJson(join(dir, "campaign.json"), record);
  deps.writeText(join(dir, "campaign.md"), renderMarkdown(record));
  deps.writeText(join(dir, "rubric.csv"), renderRubricCsv(record));
}

/*
 * The identity this arm-run has in the service: the campaign's label is the id, the arm and the levers it was given are the variant, the
 * replicate is the replicate. A label the service would refuse as an id sends no campaign (the run is then an ordinary run).
 */
export function campaignOf(args: Pick<CampaignArguments, "label" | "closedLoop" | "agentBrowser" | "grounding">, arm: Arm, replicate: number): CampaignIdentity | undefined {
  if (!CAMPAIGN_ID_PATTERN.test(args.label)) return undefined;
  const lever = (value: boolean | undefined): string => (value === undefined ? "default" : value ? "on" : "off");
  const grounding = args.grounding === undefined
    ? "default"
    : ["stitcher", "structuralSignal", "curriculum"].map((key) => {
        const value = args.grounding?.[key as keyof GroundingInput];
        return value === undefined ? "d" : value ? "1" : "0";
      }).join("");
  return {
    id: args.label,
    variant: { arm: armToken(arm), closedLoop: lever(args.closedLoop), agentBrowser: lever(args.agentBrowser), grounding },
    replicate,
  };
}

async function armRun(plan: Plan, deps: CampaignDeps, c: CampaignCase, arm: Arm, replicate: number, position: number): Promise<ArmRunResult> {
  const { args, app, snapshot } = plan;
  const label = `${args.label}-${c.id}-${armToken(arm)}${replicate}`;
  const rel = `${c.id}/${armToken(arm)}-${replicate}`;
  const armDir = join(plan.dir, rel);
  const filesDir = join(armDir, "files");
  deps.out(`[campaign] ${label}: starting`);

  await deps.waitForIdleQueue(IDLE_WAIT_MS);
  let cleanupFailed = false;
  if (c.cleanup) {
    const cleanup = await deps.runCleanup({ app, snapshot, spec: c.cleanup.spec, workspace: plan.workspace }).catch((err: unknown) => ({ ok: false, note: err instanceof Error ? err.message : String(err) }));
    cleanupFailed = !cleanup.ok;
    if (cleanupFailed) deps.out(`[campaign] ${label}: the cleanup did not succeed (${cleanup.note}); the replicate is marked invalid`);
  }
  await deps.seedStore(app, snapshot);

  const capMs = Math.round(args.wallCapMin * 60_000);
  const groundTruth = c.groundTruth !== undefined ? { groundTruthPath: c.groundTruth } : {};
  const service = c.serviceRepo !== undefined ? { serviceRepo: c.serviceRepo } : {};
  let outcome: ArmOutcome;
  let files: DeltaFile[] = [];
  let rejected: DeltaFile[] = [];
  try {
    if (arm === ARM.PIPELINE) {
      const campaign = campaignOf(args, arm, replicate);
      outcome = await deps.runPipeline({ app: app.name, kind: c.kind, sha: c.sha, ...service, shadow: true, capMs, ...groundTruth, ...(campaign ? { campaign } : {}), ...(args.closedLoop !== undefined ? { closedLoop: args.closedLoop } : {}), ...(args.agentBrowser !== undefined ? { agentBrowser: args.agentBrowser } : {}), ...(args.grounding !== undefined ? { grounding: args.grounding } : {}) });
      /* Read right after the run and before anything restores the mirror: the files are the only evidence of what the pipeline accepted. */
      const delta = await deps.pipelineDelta(app, snapshot);
      if (pipelineAccepted(outcome.report, app) && !outcome.capped && !outcome.lost) files = delta.files;
      else rejected = delta.files;
    } else {
      const accepting = arm === ARM.PLAIN_AGENT_ACCEPTED;
      outcome = await deps.runBaseline({ app: app.name, kind: c.kind, sha: c.sha, ...service, label, timeoutMin: args.wallCapMin, warm: args.warm, keepSpecsDir: filesDir, ...groundTruth, ...(accepting ? { accept: true, ...(app.needsReview ? { acceptReview: true } : {}) } : {}) });
      const delivered = await deps.readSavedFiles(filesDir);
      /* A': a delivery counts only when its acceptance accepted it, as the pipeline's files count only when its run was accepted. A report with no acceptance is no acceptance. */
      if (!accepting || (acceptanceAccepted(outcome.report) && !outcome.capped && !outcome.lost)) files = delivered;
      else rejected = delivered;
    }
  } catch (err) {
    outcome = { report: null, runId: null, capped: false, lost: true, error: err instanceof Error ? err.message : String(err), wallMs: null };
  }
  if (outcome.error) deps.out(`[campaign] ${label}: ${outcome.error}`);

  if (arm === ARM.PIPELINE) {
    if (files.length > 0) deps.saveFiles(filesDir, files);
  }
  if (rejected.length > 0) deps.saveFiles(join(armDir, "rejected"), rejected);
  if (outcome.report) deps.writeJson(join(armDir, "report.json"), outcome.report);

  /* The same judgment for both arms, outside both: detect fakes, then re-run what is left twice without retry. */
  const deliverable = files.filter((f) => !f.path.startsWith(`${SYSTEM_STATE_DIR}/`));
  const specs = specsOf(deliverable);
  const sources = new Map(deliverable.map((f) => [f.path, f.bytes.toString("utf8")]));
  const flagged = specs.map((path) => ({ path, flags: detectFakeSpec(path, sources.get(path) ?? "") }));
  const toRun = flagged.filter((s) => s.flags.length === 0).map((s) => s.path);
  let validation: ValidationOutcome = { runs: [] };
  if (toRun.length > 0 && !outcome.capped && !outcome.lost) {
    validation = await deps.validate({ workspace: plan.workspace, app, snapshot, files: deliverable, specs: toRun, namespaceSeed: label }).catch((err: unknown) => ({ runs: [], error: err instanceof Error ? err.message : String(err) }));
    if (validation.error) deps.out(`[campaign] ${label}: the re-run could not be made: ${validation.error}`);
  }
  const assessed = assessSpecs({ specs: flagged, validation: validation.runs });
  const validationInfra = toRun.length > 0 && !outcome.capped && !outcome.lost && (validation.error !== undefined || validation.runs.some((r) => r.verdict === "infra-error"));

  const report = outcome.report;
  const verdict = (report?.verdict ?? null) as RunVerdict | null;
  const result = classifyOutcome({ verdict, delivered: specs.length });
  const reasons = invalidReplicateReasons({ capped: outcome.capped, cleanupFailed, verdict, errorClass: report?.errorClass ?? null, validationInfra, runLost: outcome.lost });
  const valid = result === "spec" && assessed.length > 0 && assessed.every((s) => s.valid) && !validationInfra;
  const totalMs = report?.totalMs ?? outcome.wallMs;
  const arr: ArmRunResult = {
    caseId: c.id, arm, replicate, position, label, runId: outcome.runId,
    verdict, errorClass: report?.errorClass ?? null, note: [report?.note, outcome.error, validation.error].filter((n): n is string => typeof n === "string" && n !== "").join("; ") || null,
    outcome: result, matchesExpected: matchesExpected(c.expected.outcome, result),
    delivered: specs, savedTo: files.length > 0 ? `${rel}/files` : null,
    specs: assessed, validationRuns: validation.runs.map((r) => ({ verdict: r.verdict })),
    valid, rubric: valid ? "pending" : "n/a",
    costUsd: report?.totals.costUsd ?? null,
    wallMs: totalMs,
    wallExclOracleMs: totalMs === null ? null : totalMs - (report?.phases.coverage ?? 0),
    steps: report ? sum(report.turns.map((t) => t.stepsUsed)) : null,
    start: warmStatus(snapshot).warm ? "warm" : "cold",
    loginRewritten: files.some((f) => f.path === "auth.setup.ts"),
    capped: outcome.capped,
    invalidReplicate: reasons.length > 0, invalidReasons: reasons,
  };
  deps.writeJson(join(armDir, "result.json"), arr);
  return arr;
}

/* ── the real collaborators ────────────────────────────────────────────────────────── */

const slug = (repo: string): string => repo.replaceAll("/", "__");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const POLL_MS = 2_000;
const DISCOVER_RUN_MS = 2 * 60_000;

/** The service, the history, the mirrors and the Playwright runner of the orchestrator container, imported lazily so a test that injects its own never opens them. */
export async function defaultDeps(env: Record<string, string | undefined> = process.env): Promise<CampaignDeps> {
  const { assertQueueIdle, defaultService } = await import("./efficiency-benchmark.ts");
  const { loadAppConfig } = await import("../src/orchestrator/config-loader.ts");
  const { workdirRoot, realGit } = await import("../src/integrations/repo-mirror.ts");
  const { resolveCampaignFreeze } = await import("../src/server/campaign-freeze.ts");
  const { buildSetupAdapter, resolveCodeSandbox } = await import("../src/server/rewritten-engine-factory.ts");
  const { buildScriptExec } = await import("../src/server/exec-sandbox-factory.ts");
  const { egressGateFor, scriptOriginsFor, scriptRegistryOrigins } = await import("../src/server/egress-wiring.ts");
  const { runE2E, createDefaultE2eExecuteDeps, e2eTimeoutMs } = await import("../qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts");
  const { ProcessKillAdapter } = await import("../qa-engine/src/shared-infrastructure/process-sandbox/process-kill.adapter.ts");
  const { writeOwnedSpecFile } = await import("../qa-engine/src/shared-infrastructure/spec-path-confinement.ts");
  const { collectReport, defaultReportDeps, defaultProbeResultsDir, readGroundTruthFile, writeJsonAtomically } = await import("./probe-report.ts");
  const { loadSnapshot, restoreSuite, seedSuiteStore, warmSnapshotDir } = await import("./warm-suite.ts");
  const { suiteDelta } = await import("./campaign-suite.ts");
  const { prepareHarnessAuth } = await import("./harness-auth.ts");
  const baseline = await import("./baseline-agent.ts");

  const script = buildScriptExec(env as NodeJS.ProcessEnv, resolveCodeSandbox(env as NodeJS.ProcessEnv), egressGateFor(env as NodeJS.ProcessEnv, resolveCodeSandbox(env as NodeJS.ProcessEnv)));
  const service = await defaultService(env);
  const mirrorsRoot = workdirRoot();
  const primaryOf = (app: AppFacts): { mirrorDir: string; e2eDir: string } => {
    const mirrorDir = join(mirrorsRoot, slug(app.repo));
    return { mirrorDir, e2eDir: join(mirrorDir, "e2e") };
  };
  const headers = (): Record<string, string> => ({ "content-type": "application/json", ...(service.token ? { Authorization: `Bearer ${service.token}` } : {}) });
  const api = (path: string, init: RequestInit = {}): Promise<Response> => service.fetch(`${service.baseUrl}${path}`, { ...init, headers: { ...headers(), ...(init.headers as Record<string, string> | undefined) } });
  const json = async (res: Response): Promise<Record<string, unknown>> => ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const recordOf = async (id: string): Promise<{ status: string } | null> => {
    const res = await api(`/api/v1/runs/${encodeURIComponent(id)}`).catch(() => null);
    return res?.ok ? ((await json(res)) as { status: string }) : null;
  };
  const listRuns = async (app: string): Promise<Array<{ id: string; triggerRepo?: string; sha: string }>> => {
    const res = await api(`/api/v1/runs?app=${encodeURIComponent(app)}&limit=20`);
    if (!res.ok) throw new Error(`could not list the runs of ${app} (HTTP ${res.status})`);
    return (await res.json()) as Array<{ id: string; triggerRepo?: string; sha: string }>;
  };

  /* The suite the re-runs and the cleanup execute in: a throwaway directory under the experiment area, never a mirror. */
  const prepareWorkspace = async (workspace: string, snapshot: LoadedSnapshot, files: readonly DeltaFile[]): Promise<{ e2eDir: string; authDir: string }> => {
    const ws = join(mirrorsRoot, EXPERIMENT_COPIES_DIR, workspace);
    const e2eDir = join(ws, "e2e");
    const authDir = `${ws}.auth`;
    mkdirSync(ws, { recursive: true });
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    restoreSuite(snapshot, { mirrorDir: ws, e2eDir });
    const root = { mirrorDir: ws, specDir: e2eDir };
    for (const f of files) writeOwnedSpecFile(root, f.path, f.bytes);
    await script.scoped({ runId: `campaign-setup-${process.pid}-${Date.now()}`, ...scriptRegistryOrigins() }, () => buildSetupAdapter(script.exec, script.sandbox).setup(e2eDir));
    const config = join(e2eDir, CONFIG_FILE);
    if (!existsSync(config)) throw new Error(`the suite has no ${CONFIG_FILE} after setup`);
    writeOwnedSpecFile(root, REPO_CONFIG_COPY, readFileSync(config));
    writeOwnedSpecFile(root, CONFIG_FILE, noRetryConfig());
    return { e2eDir, authDir };
  };
  const execute = (app: AppFacts, e2eDir: string, authDir: string, namespace: string, specs: string[]) =>
    script.scoped({ runId: `campaign-run-${process.pid}-${Date.now()}`, authDir, ...scriptOriginsFor(app.name) }, () =>
      runE2E(e2eDir, { baseUrl: app.baseUrl, namespace, specFiles: specs, ...(app.testIdAttribute !== undefined ? { testIdAttribute: app.testIdAttribute } : {}) }, createDefaultE2eExecuteDeps(new ProcessKillAdapter(), e2eTimeoutMs(env), script.exec)));
  const login = (app: AppFacts, e2eDir: string, authDir: string) =>
    prepareHarnessAuth({ appName: app.name, baseUrl: app.baseUrl, ...(app.testIdAttribute !== undefined ? { testIdAttribute: app.testIdAttribute } : {}), specDir: e2eDir, authDir, phase: "pre-execute" });

  const readFilesUnder = (dir: string): DeltaFile[] => {
    const out: DeltaFile[] = [];
    const visit = (abs: string, rel: string): void => {
      if (!existsSync(abs)) return;
      for (const name of readdirSync(abs)) {
        const path = join(abs, name);
        const relPath = rel === "" ? name : `${rel}/${name}`;
        const stats = lstatSync(path);
        if (stats.isSymbolicLink()) continue;
        if (stats.isDirectory()) visit(path, relPath);
        else if (stats.isFile()) out.push({ path: relPath, bytes: readFileSync(path) });
      }
    };
    visit(dir, "");
    return out;
  };

  return {
    env,
    nowIso: () => new Date().toISOString(),
    out: (line) => console.log(line),
    readCases: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
    loadApp: (name) => {
      const app = loadAppConfig(name);
      if (app.code === true || !app.dev?.baseUrl) throw new Error(`app '${name}' has no DEV site to test against`);
      if (app.auth?.kind === "mtls") throw new Error(`app '${name}' logs in with a client certificate: the campaign does not support it`);
      return {
        name: app.name, repo: app.repo, baseUrl: app.dev.baseUrl, testDataPrefix: app.qa.testDataPrefix, shadow: app.qa.shadow === true, services: (app.services ?? []).map((s) => s.repo),
        ...(app.qa.changeCoverage?.mode !== undefined ? { coverageMode: app.qa.changeCoverage.mode } : {}),
        needsReview: app.qa.needsReview,
        ...(app.e2e?.testIdAttribute !== undefined ? { testIdAttribute: app.e2e.testIdAttribute } : {}),
      };
    },
    loadWarmSnapshot: (appName, label) => loadSnapshot(warmSnapshotDir(join(mirrorsRoot, WARM_SNAPSHOTS_DIR), appName, label), label),
    envFlags: () => ({ campaignFreeze: resolveCampaignFreeze(env) }),
    campaignDir: (label) => join(defaultCampaignsDir(), label),
    campaignExists: (label) => existsSync(join(defaultCampaignsDir(), label)),
    commitsAvailable: async (app, c) => {
      const has = (repo: string, rev: string): Promise<boolean> => realGit(["cat-file", "-e", rev], join(mirrorsRoot, slug(repo))).then(() => true, () => false);
      if (c.kind === CASE_KIND.DIFF) return (await has(app.repo, `${c.sha}^{commit}`)) ? null : `commit ${c.sha} is not in the mirror of ${app.repo}`;
      if (!(await has(c.serviceRepo!, `${c.sha}^{commit}`))) return `commit ${c.sha} is not in the mirror of ${c.serviceRepo}`;
      return (await has(app.repo, "HEAD")) ? null : `there is no mirror of ${app.repo}`;
    },
    waitForIdleQueue: async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          await assertQueueIdle(service);
          return;
        } catch (err) {
          if (Date.now() >= deadline) throw err;
          await sleep(10_000);
        }
      }
    },
    seedStore: async (app, snapshot) => {
      await seedSuiteStore(app.name, snapshot.files, snapshot.label);
    },
    runCleanup: async ({ app, snapshot, spec, workspace }) => {
      const { e2eDir, authDir } = await prepareWorkspace(workspace, snapshot, []);
      await login(app, e2eDir, authDir);
      return judgeCleanup(await script.scoped({ runId: `campaign-cleanup-${process.pid}-${Date.now()}`, authDir, ...scriptOriginsFor(app.name) }, () => runE2E(e2eDir, cleanupRunOptions(app, spec), createDefaultE2eExecuteDeps(new ProcessKillAdapter(), e2eTimeoutMs(env), script.exec))));
    },

    runPipeline: async (req) => {
      const started = Date.now();
      let runId: string | null = null;
      try {
        if (req.kind === CASE_KIND.DIFF) {
          const res = await api("/api/v1/runs", { method: "POST", body: JSON.stringify({ app: req.app, target: "e2e", mode: "diff", sha: req.sha, shadow: true, ...(req.campaign ? { campaign: req.campaign } : {}), ...(req.closedLoop !== undefined ? { closedLoop: req.closedLoop } : {}), ...(req.agentBrowser !== undefined ? { agentBrowser: req.agentBrowser } : {}), ...(req.grounding !== undefined ? { grounding: req.grounding } : {}) }) });
          const body = await json(res);
          if (!res.ok || typeof body.id !== "string") throw new Error(`the service rejected the run: ${typeof body.error === "string" ? body.error : `HTTP ${res.status}`}`);
          runId = body.id;
        } else {
          const before = new Set((await listRuns(req.app)).map((r) => r.id));
          const payload = JSON.stringify({ repo: req.serviceRepo, sha: req.sha });
          const secret = env.WEBHOOK_SECRET;
          const sign: Record<string, string> = secret ? { "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}` } : {};
          const res = await service.fetch(`${service.baseUrl}/`, { method: "POST", headers: { "content-type": "application/json", ...sign }, body: payload });
          if (res.status !== 202) throw new Error(`the webhook answered HTTP ${res.status}`);
          const found = Date.now() + DISCOVER_RUN_MS;
          while (runId === null && Date.now() < found) {
            await sleep(POLL_MS);
            runId = (await listRuns(req.app)).find((r) => !before.has(r.id) && r.triggerRepo === req.serviceRepo)?.id ?? null;
          }
          if (runId === null) throw new Error(`no run of ${req.app} triggered by ${req.serviceRepo} appeared after the webhook`);
        }
        const deadline = started + req.capMs;
        let capped = false;
        for (;;) {
          const rec = await recordOf(runId);
          if (rec?.status === "done") break;
          if (Date.now() > deadline) {
            capped = true;
            await api(`/api/v1/runs/${encodeURIComponent(runId)}`, { method: "DELETE" }).catch(() => undefined);
            const settle = Date.now() + AFTER_CAP_WAIT_MS;
            while (Date.now() < settle && (await recordOf(runId))?.status !== "done") await sleep(POLL_MS);
            break;
          }
          await sleep(POLL_MS);
        }
        const truth = req.groundTruthPath !== undefined ? readGroundTruthFile(req.groundTruthPath) : undefined;
        const report = await collectReport(runId, await defaultReportDeps(), truth);
        return { report, runId, capped, lost: false, wallMs: Date.now() - started };
      } catch (err) {
        return { report: null, runId, capped: false, lost: true, error: err instanceof Error ? err.message : String(err), wallMs: Date.now() - started };
      }
    },

    runBaseline: async (req) => {
      const started = Date.now();
      const argv = [
        "--app", req.app,
        ...(req.kind === CASE_KIND.DIFF ? ["--sha", req.sha] : ["--service", req.serviceRepo!, "--service-sha", req.sha]),
        "--timeout-min", String(req.timeoutMin), "--label", req.label, "--warm", req.warm, "--keep-specs", req.keepSpecsDir,
        ...(req.groundTruthPath !== undefined ? ["--ground-truth", req.groundTruthPath] : []),
        ...(req.accept ? ["--accept", ...(req.acceptReview ? ["--accept-review"] : [])] : []),
      ];
      const log: string[] = [];
      try {
        const inner = await baseline.defaultDeps(env);
        const code = await baseline.main(argv, { ...inner, out: (line) => { log.push(line); console.log(line); } });
        const path = join(defaultProbeResultsDir(), `${req.label}.json`);
        const report = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ProbeReport) : null;
        if (code !== 0 || report === null) return { report, runId: null, capped: false, lost: true, error: log.filter((l) => l.startsWith("error:")).join(" ") || `baseline-agent exited ${code}`, wallMs: Date.now() - started };
        return { report, runId: null, capped: false, lost: false, wallMs: Date.now() - started };
      } catch (err) {
        return { report: null, runId: null, capped: false, lost: true, error: err instanceof Error ? err.message : String(err), wallMs: Date.now() - started };
      }
    },

    pipelineDelta: async (app, snapshot) => suiteDelta(primaryOf(app), snapshot.manifest),
    readSavedFiles: async (dir) => readFilesUnder(dir),
    saveFiles: (dir, files) => {
      for (const f of files) {
        const target = join(dir, f.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, f.bytes);
      }
    },

    validate: async (req) => {
      const { e2eDir, authDir } = await prepareWorkspace(req.workspace, req.snapshot, req.files);
      await login(req.app, e2eDir, authDir);
      const runnable = req.specs.filter((s) => /^[A-Za-z0-9._/-]+\.spec\.ts$/.test(s));
      const runs: ValidationRunSummary[] = [];
      for (let i = 1; i <= 2; i++) {
        /* A spec whose name the runner refuses cannot be run: it reads as a failed re-run of that spec, not as a broken environment. */
        if (runnable.length === 0) {
          runs.push({ verdict: "fail", cases: [] });
          continue;
        }
        const run = await execute(req.app, e2eDir, authDir, `${req.app.testDataPrefix}-${req.namespaceSeed}-v${i}`, runnable);
        runs.push({ verdict: run.verdict, cases: run.cases.map((c) => ({ name: c.name, status: c.status })) });
      }
      return { runs };
    },

    writeJson: (path, value) => writeJsonAtomically(path, value),
    writeText: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, text, "utf8");
        renameSync(temporary, path);
      } catch (err) {
        rmSync(temporary, { force: true });
        throw err;
      }
    },
  };
}

/* Run as a script (not when imported by a test). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  defaultDeps()
    .then((deps) => runCampaign(process.argv.slice(2), deps))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
