/* One executed test case and the structured per-spec metadata the agent emits. Optional runtime-evidence fields follow the absent-warned best-effort contract: absent ⇒ the run degrades to string-only behavior, never a guessed value. */

export type CaseStatus = "pass" | "fail" | "flaky";

export interface QaCase {
  name: string;
  status: CaseStatus;
  detail?: string;
  flow?: string;
  objective?: string;
  reason?: string;
  durationMs?: number;
  failureDom?: string;
  file?: string;
  httpStatus?: number;
  finalUrl?: string;
  /* Deduped, capped browser-console error-level entries and uncaught pageerror exceptions. Diagnostic only — never blocks, auto-passes, or masks a generated-test defect. Absent when capture missed. */
  runtimeErrors?: { type: string; text: string }[];
  /* Failed requests the page saw, each URL reduced to origin+pathname — never a query or fragment. Diagnostic only — never blocks or masks a defect. Absent when capture missed. */
  networkErrors?: { url: string; status?: number; errorText?: string; resourceType?: string }[];
  /* Derived from `networkErrors` and the run's egress report, never reported by the browser. Absent when there are no network errors. */
  networkClass?: "egress" | "backend" | "dns" | "other";
  /* Whether the page had settled when the capture read it: data requests (fetch/xhr) still in flight, ms since the last data response (absent before any), and whether the tree was the same on a second read a moment later. Absent when capture missed. */
  failureSettle?: FailureSettle;
  /* The result count the app's declared data state (dev.dataState) showed on the failure-point page. Absent when no data state matched that page or it could not be read. */
  failureResultCount?: number;
  /* The failure-point capture of every failed attempt the fixture dumped, in retry order. The fields above keep the latest retry's capture; these say what each attempt saw, for telemetry. Empty when the execution captured failure points and no dump matched; absent when it did not capture. */
  failureAttempts?: FailureAttemptEvidence[];
}

/* One attempt's failure-point capture, reduced to facts: the page's address and status, the data state, whether it had settled, and counts and a digest of what it showed. The tree itself stays on the case (failureDom) for the fix loop. */
export interface FailureAttemptEvidence {
  retry: number;
  finalUrl?: string;
  httpStatus?: number;
  resultCount?: number;
  settle?: FailureSettle;
  runtimeErrorCount: number;
  /* The first runtime error's text, when there was one. */
  runtimeError?: string;
  networkErrorCount: number;
  /* Failed background requests (beacons, third-party events) the page made before this attempt failed, which are not network errors of the case. Absent when there were none. */
  backgroundNetworkCount?: number;
  /* Lines of the parsed accessibility tree and the sha256 of those lines; absent when the dump had no tree. */
  domLines?: number;
  domSha256?: string;
}

export interface FailureSettle {
  inFlight: number;
  quietMs?: number;
  treeStable: boolean;
}

/* A capture read while the page was still changing: a data request in flight, or a tree that changed on the second read. Such a tree is a moment of a render, not the page's settled state. */
export function failureUnsettled(settle: FailureSettle | undefined): boolean {
  return settle !== undefined && (settle.inFlight > 0 || !settle.treeStable);
}

export interface SpecMeta {
  file: string;
  flow: string;
  objective: string;
  targets: string[];
  sha256?: string;
}

export interface SpecRecord {
  name: string;
  objective?: string;
  flow?: string;
}
