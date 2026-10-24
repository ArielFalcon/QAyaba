/*
 * The pure part of the campaign (scripts/campaign.ts): the cases file, the command line, the order of the arms, and the
 * rules that turn what an arm delivered into "valid or not". EXPERIMENT ONLY; nothing here touches the service.
 *
 * "Green" is not comparable between the arms as they run: the plain agent counts any spec that passed its own two runs,
 * the pipeline executes once with retries and, after a reviewer rejection, accepts regenerated specs that never ran. So the
 * campaign judges both the same way, outside either arm: the delivered specs are re-run twice with no retry, and a spec
 * that looks fake is never valid (scripts/fake-pass-detector.ts).
 */
import type { RunVerdict } from "@kernel/run-verdict.ts";
import { isCoordinationMode, type CoordinationMode } from "@kernel/coordination.ts";
import type { GroundingInput } from "@kernel/contract/commands.ts";
import type { FakeFlag } from "./fake-pass-detector.ts";
import { assertFileName } from "./probe-report.ts";

/* A: the plain agent, whose own two runs are not believed (the campaign re-runs what it delivered). A': the same agent, whose delivery goes through the acceptance the pipeline's output is judged by, so a delivery counts only when the pipeline would have kept it. B: the pipeline. */
export const ARM = { PLAIN_AGENT: "A", PLAIN_AGENT_ACCEPTED: "A'", PIPELINE: "B" } as const;
export type Arm = (typeof ARM)[keyof typeof ARM];
const ARM_VALUES: readonly string[] = Object.values(ARM);
/* The arms of a campaign that names none: the two the experiment has always compared. */
const DEFAULT_ARMS: readonly Arm[] = [ARM.PLAIN_AGENT, ARM.PIPELINE];

/** Whether the arm is the plain agent, with or without the acceptance. */
export const isPlainAgentArm = (arm: Arm): boolean => arm === ARM.PLAIN_AGENT || arm === ARM.PLAIN_AGENT_ACCEPTED;

/** The arm as a file name and a label can carry it: A' has no apostrophe there. */
export const armToken = (arm: Arm): string => (arm === ARM.PLAIN_AGENT_ACCEPTED ? "Ap" : arm);

export const CASE_KIND = { DIFF: "diff", CROSS_REPO: "cross-repo" } as const;
export type CaseKind = (typeof CASE_KIND)[keyof typeof CASE_KIND];

export const EXPECTED_OUTCOME = { SPEC: "spec", NOOP: "noop", EITHER: "either" } as const;
export type ExpectedOutcome = (typeof EXPECTED_OUTCOME)[keyof typeof EXPECTED_OUTCOME];

/** How many times a delivered spec set is re-run, with no retry, before it can be called valid. */
export const VALIDITY_RUNS = 2;
export const DEFAULT_WALL_CAP_MIN = 30;
export const MAX_REPLICAS = 20;

/* ── the cases file ────────────────────────────────────────────────────────────────── */

export interface CaseExpectation {
  outcome: ExpectedOutcome;
  /** What a valid spec for this case must check, in words: the owner scores the valid candidates against it. */
  mustVerify: string;
}

export interface CampaignCleanup {
  /** A spec in the warm snapshot's suite that removes what the case's specs create on DEV; run before every arm-run of the case. */
  spec: string;
}

export interface CampaignCase {
  id: string;
  kind: CaseKind;
  /** The app's commit (`diff`) or the service's (`cross-repo`). */
  sha: string;
  serviceRepo?: string;
  /** A ground-truth file (config/benchmarks/ground-truth/) to score both arms' evidence against, for a case that has one. */
  groundTruth?: string;
  expected: CaseExpectation;
  cleanup?: CampaignCleanup;
}

export interface CampaignCases {
  app: string;
  cases: CampaignCase[];
}

const HEX_COMMIT_ID = /^[0-9a-f]{7,40}$/i;
const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SPEC_PATH = /^[A-Za-z0-9._/-]+\.spec\.ts$/;
const CASE_KEYS: ReadonlySet<string> = new Set(["id", "kind", "sha", "serviceRepo", "groundTruth", "expected", "cleanup"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseCase(raw: unknown, index: number): CampaignCase {
  if (!isRecord(raw)) throw new Error(`cases[${index}] must be an object`);
  const name = typeof raw.id === "string" && raw.id !== "" ? `case '${raw.id}'` : `cases[${index}]`;
  for (const key of Object.keys(raw)) if (!CASE_KEYS.has(key)) throw new Error(`${name}: unknown key '${key}'`);
  if (typeof raw.id !== "string") throw new Error(`${name}: id must be a string`);
  try {
    assertFileName(raw.id, "case id");
  } catch (err) {
    throw new Error(`${name}: id: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw.kind !== CASE_KIND.DIFF && raw.kind !== CASE_KIND.CROSS_REPO) throw new Error(`${name}: kind must be '${CASE_KIND.DIFF}' or '${CASE_KIND.CROSS_REPO}'`);
  if (typeof raw.sha !== "string" || !HEX_COMMIT_ID.test(raw.sha)) throw new Error(`${name}: sha must be 7-40 hex characters`);
  if (raw.kind === CASE_KIND.CROSS_REPO) {
    if (typeof raw.serviceRepo !== "string" || !REPO_SLUG.test(raw.serviceRepo)) throw new Error(`${name}: serviceRepo must be <owner>/<repo> for a cross-repo case`);
  } else if (raw.serviceRepo !== undefined) {
    throw new Error(`${name}: serviceRepo only belongs to a cross-repo case`);
  }
  if (raw.groundTruth !== undefined && (typeof raw.groundTruth !== "string" || raw.groundTruth === "")) throw new Error(`${name}: groundTruth must be a file path`);
  const expected = raw.expected;
  if (!isRecord(expected)) throw new Error(`${name}: expected must be an object`);
  const outcomes: readonly unknown[] = Object.values(EXPECTED_OUTCOME);
  if (!outcomes.includes(expected.outcome)) throw new Error(`${name}: expected.outcome must be one of ${Object.values(EXPECTED_OUTCOME).join(", ")}`);
  if (typeof expected.mustVerify !== "string" || expected.mustVerify.trim() === "") throw new Error(`${name}: expected.mustVerify must say what a valid spec has to check`);
  let cleanup: CampaignCleanup | undefined;
  if (raw.cleanup !== undefined) {
    const spec = isRecord(raw.cleanup) ? raw.cleanup.spec : undefined;
    if (typeof spec !== "string" || !SPEC_PATH.test(spec) || spec.startsWith("/") || spec.split("/").some((s) => s === ".." || s === "." || s === "")) {
      throw new Error(`${name}: cleanup.spec must be a *.spec.ts path inside the suite directory`);
    }
    cleanup = { spec };
  }
  return {
    id: raw.id,
    kind: raw.kind,
    sha: raw.sha,
    ...(typeof raw.serviceRepo === "string" ? { serviceRepo: raw.serviceRepo } : {}),
    ...(typeof raw.groundTruth === "string" ? { groundTruth: raw.groundTruth } : {}),
    expected: { outcome: expected.outcome as ExpectedOutcome, mustVerify: expected.mustVerify.trim() },
    ...(cleanup ? { cleanup } : {}),
  };
}

/** Validates the cases file. Throws, naming the case and the field, on the first problem: a campaign on a misread file would be a waste of DEV and tokens. */
export function parseCases(raw: unknown): CampaignCases {
  if (!isRecord(raw)) throw new Error("the cases file must be a JSON object { app, cases }");
  if (typeof raw.app !== "string" || raw.app === "") throw new Error("the cases file needs an app name");
  try {
    assertFileName(raw.app, "app");
  } catch (err) {
    throw new Error(`app: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) throw new Error("the cases file needs a non-empty cases array");
  const cases = raw.cases.map(parseCase);
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`duplicate case id '${c.id}': results are keyed by it`);
    seen.add(c.id);
  }
  return { app: raw.app, cases };
}

/* ── the command line ──────────────────────────────────────────────────────────────── */

export interface CampaignArguments {
  casesPath: string;
  replicas: number;
  label: string;
  arms: Arm[];
  wallCapMin: number;
  /** The warm-suite snapshot seeded into the suite store (the pipeline) and applied to the throwaway copy (the plain agent) before every arm-run. */
  warm: string;
  /** Run the pipeline arm on an app whose config is not shadow (a cross-repo case cannot be forced to shadow). */
  allowNonShadow: boolean;
  /** Skip the check that this process sees QA_CAMPAIGN_FREEZE on (for a server started with it by other means). */
  skipEnvChecks: boolean;
  /** Check everything and print the plan; start nothing and spend nothing. */
  dryRun: boolean;
  /** The pipeline arm's own choice about the run_spec loop (an A/B), overriding the app's setting. Absent: the app's setting decides. */
  closedLoop?: boolean;
  /** The pipeline arm's own choice about the authenticated agent browser (an A/B), overriding the app's setting. Absent: the app's setting decides. */
  agentBrowser?: boolean;
  /** The pipeline arm's own choice of coordination mode (an A/B), overriding the app's setting. Absent: the app's setting decides. */
  coordinationMode?: CoordinationMode;
  /** The pipeline arm's own choice of grounding sources (an A/B), overriding the app's settings. Absent: the app's setting decides. */
  grounding?: GroundingInput;
}

export type ParsedArguments = { ok: true; args: CampaignArguments } | { ok: false; problem: string };

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const valued = new Set(["--cases", "--replicas", "--label", "--arms", "--wall-cap-min", "--warm", "--closed-loop", "--agent-browser", "--coordination", "--grounding"]);
  const boolean = new Set(["--allow-non-shadow", "--skip-env-checks", "--dry-run"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (valued.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { ok: false, problem: `error: ${a} needs a value` };
      values[a] = v;
    } else if (boolean.has(a)) flags.add(a);
    else return { ok: false, problem: `error: unknown argument ${a}` };
  }
  for (const required of ["--cases", "--replicas", "--label", "--warm"]) if (!values[required]) return { ok: false, problem: `error: ${required} is required` };
  const replicas = Number(values["--replicas"]);
  if (!Number.isInteger(replicas) || replicas < 1 || replicas > MAX_REPLICAS) return { ok: false, problem: `error: --replicas needs a whole number from 1 to ${MAX_REPLICAS}` };
  const arms = (values["--arms"] ?? DEFAULT_ARMS.join(",")).split(",");
  if (arms.some((a) => !ARM_VALUES.includes(a)) || new Set(arms).size !== arms.length) return { ok: false, problem: `error: --arms is a comma-separated, non-repeating list of ${ARM_VALUES.join(", ")}` };
  const wallCapMin = values["--wall-cap-min"] === undefined ? DEFAULT_WALL_CAP_MIN : Number(values["--wall-cap-min"]);
  if (!Number.isFinite(wallCapMin) || wallCapMin <= 0) return { ok: false, problem: "error: --wall-cap-min needs a positive number of minutes" };
  if (values["--closed-loop"] !== undefined && values["--closed-loop"] !== "on" && values["--closed-loop"] !== "off") return { ok: false, problem: 'error: --closed-loop takes "on" or "off"' };
  if (values["--agent-browser"] !== undefined && values["--agent-browser"] !== "on" && values["--agent-browser"] !== "off") return { ok: false, problem: 'error: --agent-browser takes "on" or "off"' };
  if (values["--coordination"] !== undefined && !isCoordinationMode(values["--coordination"])) return { ok: false, problem: 'error: --coordination takes "single" or "lead-sidekicks"' };
  const grounding: GroundingInput = {};
  if (values["--grounding"] !== undefined) {
    for (const pair of values["--grounding"].split(",")) {
      const [key, value] = pair.split("=");
      if (!["explorer", "stitcher", "structuralSignal", "curriculum"].includes(key ?? "") || (value !== "on" && value !== "off")) {
        return { ok: false, problem: "error: --grounding takes comma-separated explorer|stitcher|structuralSignal|curriculum=on|off" };
      }
      grounding[key as keyof GroundingInput] = value === "on";
    }
  }
  try {
    assertFileName(values["--label"]!, "label");
    assertFileName(values["--warm"]!, "warm snapshot label");
  } catch (err) {
    return { ok: false, problem: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
  return {
    ok: true,
    args: {
      casesPath: values["--cases"]!, replicas, label: values["--label"]!, arms: arms as Arm[], wallCapMin, warm: values["--warm"]!,
      allowNonShadow: flags.has("--allow-non-shadow"), skipEnvChecks: flags.has("--skip-env-checks"), dryRun: flags.has("--dry-run"),
      ...(values["--closed-loop"] !== undefined ? { closedLoop: values["--closed-loop"] === "on" } : {}),
      ...(values["--agent-browser"] !== undefined ? { agentBrowser: values["--agent-browser"] === "on" } : {}),
      ...(isCoordinationMode(values["--coordination"]) ? { coordinationMode: values["--coordination"] } : {}),
      ...(Object.keys(grounding).length > 0 ? { grounding } : {}),
    },
  };
}

/** The arms in the order replicate `replicate` (1-based) runs them: as given on odd replicates, reversed on even ones (AB, BA, AB, ...). */
export function armOrder(replicate: number, arms: readonly Arm[]): Arm[] {
  return replicate % 2 === 1 ? [...arms] : [...arms].reverse();
}

/* ── which spec passed ─────────────────────────────────────────────────────────────── */

export interface CaseStatus {
  name: string;
  status: string;
}

export type SpecRunStatus = "pass" | "fail" | "missing";

const TITLE_SEP = " › ";

/**
 * Each spec's result in one run: `pass` when it had at least one test and every one passed, `fail` when a test of it did not pass (a skipped test did not pass), `missing` when none
 * of its tests ran. A test's title starts with the file it lives in, relative to the Playwright test directory.
 */
export function specStatuses(cases: readonly CaseStatus[], specs: readonly string[]): Map<string, SpecRunStatus> {
  const result = new Map<string, SpecRunStatus>();
  for (const spec of specs) {
    const own = cases.filter((c) => {
      const file = c.name.split(TITLE_SEP)[0]!.trim();
      return file === spec || spec.endsWith(`/${file}`) || file.endsWith(`/${spec}`);
    });
    result.set(spec, own.length === 0 ? "missing" : own.every((c) => c.status === "pass") ? "pass" : "fail");
  }
  return result;
}

/* ── valid or not ──────────────────────────────────────────────────────────────────── */

/** One re-run of the delivered specs, as the repo's Playwright runner classified it. */
export interface ValidationRunSummary {
  verdict: RunVerdict;
  cases: CaseStatus[];
}

export interface SpecAssessment {
  path: string;
  flags: FakeFlag[];
  /** Whether the spec was re-run at all (a flagged spec is not). */
  ran: boolean;
  /** One entry per re-run. */
  runs: SpecRunStatus[];
  valid: boolean;
}

/** The delivered specs, each with what the detector said, against the re-runs of the whole set. */
export function assessSpecs(input: { specs: ReadonlyArray<{ path: string; flags: readonly FakeFlag[] }>; validation: readonly ValidationRunSummary[] }): SpecAssessment[] {
  return input.specs.map(({ path, flags }) => {
    const flagged = flags.length > 0;
    const runs = flagged ? [] : input.validation.map((run) => specStatuses(run.cases, [path]).get(path) ?? "missing");
    const valid = !flagged && runs.length === VALIDITY_RUNS && runs.every((r) => r === "pass");
    return { path, flags: [...flags], ran: !flagged && runs.length > 0, runs, valid };
  });
}

/* ── what the arm did ──────────────────────────────────────────────────────────────── */

export type Outcome = "spec" | "noop" | "none";

/** `spec` when files were delivered, `noop` when the arm declared there was nothing to test, `none` when it did neither (an error, a cut, a silence). */
export function classifyOutcome(input: { verdict: RunVerdict | null; delivered: number }): Outcome {
  if (input.delivered > 0) return "spec";
  return input.verdict === "skipped" ? "noop" : "none";
}

export function matchesExpected(expected: ExpectedOutcome, outcome: Outcome): boolean {
  if (outcome === "none") return false;
  return expected === EXPECTED_OUTCOME.EITHER || expected === outcome;
}

/* ── a replicate that cannot be compared ───────────────────────────────────────────── */

/* An infra-error the arm brings on itself is its result; any other is the environment's, and the replicate says nothing about the arm. */
const ARM_OWN_ERROR_CLASSES: ReadonlySet<string> = new Set(["E-NO-DECISION", "E-STEP-BUDGET", "E-TIME-BUDGET"]);

export interface InvalidReplicateInput {
  capped: boolean;
  cleanupFailed: boolean;
  verdict: RunVerdict | null;
  errorClass: string | null;
  /** The re-run could not execute (DEV down, no report). */
  validationInfra: boolean;
  /** The run could not be started, found or finished. */
  runLost: boolean;
}

export function invalidReplicateReasons(input: InvalidReplicateInput): string[] {
  const reasons: string[] = [];
  if (input.capped) reasons.push("the wall cap cut the run");
  if (input.cleanupFailed) reasons.push("the case's cleanup failed, so leftovers may have changed the start");
  if (input.runLost) reasons.push("the run was lost (could not be started, found or finished)");
  if (input.verdict === "infra-error" && (input.errorClass === null || !ARM_OWN_ERROR_CLASSES.has(input.errorClass))) {
    reasons.push(`infra-error${input.errorClass ? ` ${input.errorClass}` : ""}: the environment, not the arm`);
  }
  if (input.validationInfra) reasons.push("the re-run could not execute against DEV");
  return reasons;
}
