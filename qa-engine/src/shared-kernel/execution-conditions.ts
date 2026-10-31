/*
 * The conditions a Playwright execution of the suite runs under, as one value (RFC-0015, ADR-0023): built in one place (the runner,
 * from what it hands the child) and recorded on every execution's span and on the run record. An execution is judging (its outcome
 * decides something: a verdict, a fix-loop round, a per-file acceptance, a run_spec proof, a mutant's kill) or measuring (its outcome
 * is a signal only: coverage, an observation). The contract's digest covers the instrumentation, the app's own workers, the suite
 * profile and the durable geolocation. The verdict's, the fix loop's and an acceptance's executions add no instrumentation, so they share
 * one digest; a run_spec call adds the write counter and a mutant's re-run adds coverage, the observation and the mutant's route (it is
 * judged against the measurement execution, which runs instrumented the same way), and each records what it adds as its deviations.
 * The namespace, the spec set and its order, the retries and the process timeout are recorded and never decide the digest (the
 * namespace differs by design, the spec set is what the caller asked for, a case is judged on its first attempt in every judging
 * execution, and a run_spec call is held to its own budget). Pure: no I/O and no clock.
 */

import type { ExecPurpose } from "./exec-purpose.ts";
import { sha256Hex } from "./content-hash.ts";
import type { Attrs } from "./telemetry/attribute-registry.ts";

export type ExecutionKind = "judging" | "measuring";

/* What an execution of each purpose is: a purpose whose outcome decides something judges; an observation or a measurement only measures, and the control load and the cleanup pass judge nothing. */
const KIND_OF: Record<ExecPurpose, ExecutionKind> = {
  suite: "judging",
  acceptance: "judging",
  "fix-retry": "judging",
  "run-spec": "judging",
  mutant: "judging",
  measurement: "measuring",
  observation: "measuring",
  control: "measuring",
  cleanup: "measuring",
};

export const kindOfPurpose = (purpose: ExecPurpose): ExecutionKind => KIND_OF[purpose];

/* What the fixtures add to a test besides the test itself. */
export interface ExecutionInstrumentation {
  /* V8 precise coverage (the seed's `_coverage`, PW_COVERAGE). */
  coverage: boolean;
  /* The request listener and the accessible-tree read of the observation (PW_OBSERVE). */
  observe: boolean;
  /* A `page.route` of the mutation fixture (PW_MUTANT): a mutant's edit, or a selection of the tests to run that edits no script. */
  route: boolean;
  /* The DEV-write ledger and the control load of a run_spec call (PW_COUNT_DEV_WRITES). */
  writeCounter: boolean;
}

export interface ExecutionConditions {
  purpose: ExecPurpose;
  kind: ExecutionKind;
  /* The launcher profile the child runs under. */
  profile: "suite";
  instrumentation: ExecutionInstrumentation;
  /* Attempts after a failure: a number the caller set, or the app's own config. */
  retries: number | "config";
  /* The app's own config decides workers and parallelism; no execution overrides them. */
  workers: "config";
  /*
   * The spec files the execution was handed, suite-relative and in the order handed to Playwright (its test list), at most
   * MAX_RECORDED_SPEC_FILES of them with the rest counted in `omitted`; "suite" when it was handed none and ran the whole suite in
   * Playwright's own order. `grep` says whether a title filter narrowed them.
   */
  specs: { files: readonly string[] | "suite"; omitted?: number; grep: boolean };
  /* The process timeout of the call, and the global timeout handed to Playwright when the caller set one of its own. */
  timeouts: { processMs: number; globalMs?: number };
  /* When the session the child is given was signed in by the run, and its age when the child started. Absent: the run did not say. */
  session?: { signedInAt: string; ageMs: number };
  geolocation?: { latitude: number; longitude: number };
  /* The data namespace: differs by design, recorded. */
  namespace: string;
}

export interface ExecutionConditionsInput {
  purpose: ExecPurpose;
  instrumentation: ExecutionInstrumentation;
  retries?: number;
  specFiles?: readonly string[];
  grep?: string;
  processTimeoutMs: number;
  globalTimeoutMs?: number;
  session?: { signedInAt: number };
  geolocation?: { latitude: number; longitude: number };
  namespace: string;
  /* The time the child starts, wall-clock ms: the session's age is counted to it. */
  startedAt: number;
}

/* What the seed's mutation fixture reads (PW_MUTANT) to run only `tests` and edit no script: an edit that names no script, so no response (none has an empty address or digest) is touched and every other test is skipped. */
export const testSelection = (tests: readonly string[]): string => JSON.stringify({ url: "", sha256: "", start: 0, end: 0, replacement: "", tests });

/* The most spec files an execution's conditions name; the rest are counted. */
export const MAX_RECORDED_SPEC_FILES = 32;

/* The spec set as the conditions keep it: the files in the order given, bounded, and how many the bound left out. */
function specsOf(input: ExecutionConditionsInput): ExecutionConditions["specs"] {
  const grep = input.grep !== undefined;
  const files = input.specFiles ?? [];
  if (files.length === 0) return { files: "suite", grep };
  const omitted = files.length - MAX_RECORDED_SPEC_FILES;
  return { files: files.slice(0, MAX_RECORDED_SPEC_FILES), ...(omitted > 0 ? { omitted } : {}), grep };
}

/* The one builder of an execution's conditions. */
export function executionConditions(input: ExecutionConditionsInput): ExecutionConditions {
  return {
    purpose: input.purpose,
    kind: kindOfPurpose(input.purpose),
    profile: "suite",
    instrumentation: { ...input.instrumentation },
    retries: input.retries ?? "config",
    workers: "config",
    specs: specsOf(input),
    timeouts: { processMs: input.processTimeoutMs, ...(input.globalTimeoutMs !== undefined ? { globalMs: input.globalTimeoutMs } : {}) },
    ...(input.session ? { session: { signedInAt: new Date(input.session.signedInAt).toISOString(), ageMs: Math.max(0, input.startedAt - input.session.signedInAt) } } : {}),
    ...(input.geolocation ? { geolocation: { latitude: input.geolocation.latitude, longitude: input.geolocation.longitude } } : {}),
    namespace: input.namespace,
  };
}

/* The conditions the contract fixes, in a fixed order: two executions with the same digest ran under the same contract. */
export function contractDigest(c: ExecutionConditions): string {
  const fixed = [c.profile, c.workers, c.instrumentation.coverage, c.instrumentation.observe, c.instrumentation.route, c.instrumentation.writeCounter, c.geolocation?.latitude ?? null, c.geolocation?.longitude ?? null];
  return sha256Hex(JSON.stringify(fixed)).slice(0, 16);
}

/* The instrumentation an execution adds to the contract, by name: what a judging execution records as its deviations, and what a measuring one records as the conditions it adds. Empty when it adds none. */
export function deviationsOf(c: ExecutionConditions): string[] {
  const out: string[] = [];
  if (c.instrumentation.coverage) out.push("coverage");
  if (c.instrumentation.observe) out.push("observation");
  if (c.instrumentation.route) out.push("route");
  if (c.instrumentation.writeCounter) out.push("write-counter");
  return out;
}

/* The conditions as attributes of the execution's span. */
export function conditionsAttributes(c: ExecutionConditions): Attrs {
  const deviations = deviationsOf(c);
  return {
    "qayaba.exec.contract.digest": contractDigest(c),
    "qayaba.exec.contract.kind": c.kind,
    "qayaba.exec.contract.deviations": deviations.length > 0 ? deviations.join(",") : "none",
    "qayaba.exec.retries": c.retries === "config" ? "config" : String(c.retries),
    "qayaba.exec.spec_files": c.specs.files === "suite" ? "suite" : String(c.specs.files.length + (c.specs.omitted ?? 0)),
    ...(c.timeouts.globalMs !== undefined ? { "qayaba.exec.global_timeout_ms": c.timeouts.globalMs } : {}),
    ...(c.session ? { "qayaba.exec.session.age_ms": c.session.ageMs } : {}),
  };
}

/* One execution as the run record keeps it. */
export interface ExecutionRecord {
  purpose: ExecPurpose;
  kind: ExecutionKind;
  namespace: string;
  digest: string;
  deviations: string[];
  retries: number | "config";
  /* The spec files it was handed, in order and bounded, or "suite"; `specFilesOmitted` counts those past the bound. */
  specFiles: string[] | "suite";
  specFilesOmitted?: number;
  sessionAgeMs?: number;
  /* The DEV writes the run had counted when the execution started (its run_spec calls' ledger: no other execution counts its writes); absent when the run counts none. */
  devWritesBefore?: number;
}

export const recordOfExecution = (c: ExecutionConditions, at: { devWritesBefore?: number } = {}): ExecutionRecord => ({
  purpose: c.purpose,
  kind: c.kind,
  namespace: c.namespace,
  digest: contractDigest(c),
  deviations: deviationsOf(c),
  retries: c.retries,
  specFiles: c.specs.files === "suite" ? "suite" : [...c.specs.files],
  ...(c.specs.omitted !== undefined ? { specFilesOmitted: c.specs.omitted } : {}),
  ...(c.session ? { sessionAgeMs: c.session.ageMs } : {}),
  ...(at.devWritesBefore !== undefined ? { devWritesBefore: at.devWritesBefore } : {}),
});

/* The most executions a run record lists; the rest are counted. */
export const MAX_RECORDED_EXECUTIONS = 64;

/* The executions of a run as its record keeps them: in the order they ran, the first MAX_RECORDED_EXECUTIONS, and how many more there were. */
export interface ExecutionsSignal {
  runs: ExecutionRecord[];
  omitted?: number;
  /* How the run's checks of its session came out, each asked by a judging execution whose failures looked like the login page; absent when none was asked. */
  sessionChecks?: { lost: number; held: number; unknown: number };
}
