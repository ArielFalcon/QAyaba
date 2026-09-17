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
