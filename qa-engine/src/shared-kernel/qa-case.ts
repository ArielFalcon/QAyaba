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
