/* Pure failure adjudicator for FixLoop — distinct from test-execution's AdjudicateService (runner-infra reclassification). First match wins: runner_infra → dev_infra → attributed 5xx app_defect → isLikelyRealBug app_defect → generated_test_defect/continue → break-needs-human → objective_gap (label only) → default continue. Pure: no I/O, never throw. */

import type { RunMode } from "@kernel/run-mode.ts";
import { isLikelyRealBug, classifyFailure } from "./helpers/progress-gate.ts";
import { PLAYWRIGHT_INFRA_RE } from "./helpers/playwright-infra.ts";

/* Closed adjudicator enums. */

export const ADJ_CLASS = {
  APP_DEFECT: "app_defect",
  GENERATED_TEST_DEFECT: "generated_test_defect",
  RUNNER_INFRA: "runner_infra",
  DEV_INFRA: "dev_infra",
  OBJECTIVE_GAP: "objective_gap",
} as const;
export type AdjudicatorClass = (typeof ADJ_CLASS)[keyof typeof ADJ_CLASS];

export const ADJ_CONFIDENCE = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
} as const;
export type AdjudicatorConfidence = (typeof ADJ_CONFIDENCE)[keyof typeof ADJ_CONFIDENCE];

export const ADJ_ACTION = {
  BREAK_ISSUE: "break-issue",
  BREAK_NEEDS_HUMAN: "break-needs-human",
  CONTINUE: "continue",
} as const;
export type AdjudicatorAction = (typeof ADJ_ACTION)[keyof typeof ADJ_ACTION];

/* classifyFailure's return type re-exported as an alias so callers can type the precomputed failureClasses array without importing a literal union directly. */
export type AdjFailureClass = ReturnType<typeof classifyFailure>;

/* ── Evidence and verdict types ───────────────────────────────────────────────── */

/* All fields are pre-computed by the caller. The function performs no I/O. */
export interface AdjudicatorEvidence {
  /** True for code-mode runs (no web env): skips app_defect and objective_gap rules. */
  isCode: boolean;
  /** True when every proposed selector was present+unique in the failure-point snapshot. */
  allUnique: boolean;
  /** Failure detail strings from failed cases: `failed.map(c => c.detail ?? "")`. */
  failureDetails: string[];
  /** Per-detail failure class: `failed.map(c => classifyFailure(c.detail ?? ""))`. */
  failureClasses: AdjFailureClass[];
  /** Number of verifiable-absent selectors (Lever-2 absentKeys.size). */
  absentKeysCount: number;
  /** True if the fix-loop may spend another retry (decideProgress.spend). */
  gateSpend: boolean;
  /** Human-readable gate decision reason (carried into verdict.reason). */
  gateReason: string;
  /** Pre-computed DEV health: true for code mode (no web env) or when DEV is responding. */
  devHealthy: boolean;
  /** Run mode from RunOptions.mode. */
  mode: RunMode;
  /** Diff mode: intent.changedFiles; manual mode: [opts.guidance] (filtered non-empty). */
  objectiveSource: string[];
  /** Failing case file basenames: `failed.map(c => c.file)` (may contain undefined). */
  failingFiles: (string | undefined)[];
  /** Per-failed-case HTTP status (`failed.map(c => c.httpStatus)`). Undefined when capture missed. */
  httpStatuses: (number | undefined)[];
  /** Per-failed-case console/pageerror entries (`failed.map(c => c.runtimeErrors ?? [])`). Empty inner array means none captured — never undefined at the outer level. */
  runtimeErrorsByCase: { type: string; text: string }[][];
}

export interface AdjudicatorVerdict {
  class: AdjudicatorClass;
  confidence: AdjudicatorConfidence;
  action: AdjudicatorAction;
  /** Human-legible explanation threaded into Issue labels/body for observability. */
  reason: string;
}

/* classifyRuntimeErrors: pure runtime-error classifier. */

export interface RuntimeErrorVerdict {
  /** True only on a STRONG framework/uncaught signal — conservative by design (see module doc). */
  appDefect: boolean;
  /** Human-legible reasons, one per matched entry, threaded into the adjudicator verdict reason. */
  reasons: string[];
}

const FRAMEWORK_ERROR_RE = /\bNG\d+\b|ERROR Error:|Uncaught|Unhandled Promise rejection/;

/* Benign noise that must NEVER set appDefect, even though it can share surface words with the patterns above (e.g. a "Failed to load resource" line has no "Error:" but is excluded defensively here too, in case the format changes). Resource load failures (4xx and generic network errors, including favicon) are expected background chatter, not app breakage. */
const BENIGN_NOISE_RE = /Failed to load resource|favicon|net::ERR_/i;

/* Classifies captured console/pageerror entries into appDefect. Conservative: only a pageerror or a framework-error signature sets true; a single genuine entry among noise is enough. */
export function classifyRuntimeErrors(errors: { type: string; text: string }[]): RuntimeErrorVerdict {
  const reasons: string[] = [];
  for (const e of errors) {
    /* Any pageerror is, by definition, an uncaught JS exception — always a strong signal regardless of its text (a Playwright `pageerror` event only fires for genuinely uncaught exceptions). */
    if (e.type === "pageerror") {
      reasons.push(`uncaught page error: ${e.text}`);
      continue;
    }
    /* Console entries: exclude benign noise FIRST (defense in depth), then match the generic framework-error signature set. */
    if (BENIGN_NOISE_RE.test(e.text)) continue;
    if (FRAMEWORK_ERROR_RE.test(e.text)) {
      reasons.push(`framework runtime error: ${e.text}`);
    }
  }
  return { appDefect: reasons.length > 0, reasons };
}

/* ── Pure decision function ───────────────────────────────────────────────────── */

/**
 * Adjudicates a failing run iteration. Pure, sync, never throws.
 * Returns the first matching rule's verdict.
 */
export function adjudicate(evidence: AdjudicatorEvidence): AdjudicatorVerdict {
  const {
    isCode,
    allUnique,
    failureDetails,
    failureClasses,
    absentKeysCount,
    gateSpend,
    gateReason,
    devHealthy,
    mode,
    objectiveSource,
    failingFiles,
    httpStatuses,
    runtimeErrorsByCase,
  } = evidence;

  /* Rule 1: runner_infra — every failure matches the Playwright launcher infra pattern (same regex as allFailuresAreRunnerInfra). Highest priority: never burn retries on a launcher crash. */
  if (failureDetails.length > 0 && failureDetails.every((d) => PLAYWRIGHT_INFRA_RE.test(d))) {
    return {
      class: ADJ_CLASS.RUNNER_INFRA,
      confidence: ADJ_CONFIDENCE.HIGH,
      action: ADJ_ACTION.BREAK_ISSUE, /* caller routes to infra-error, no repo Issue */
      reason: "Playwright runner infrastructure failure — browser could not launch",
    };
  }

  /* Rule 2: dev_infra — DEV health check failed (pre-computed; no I/O here). Sits above app_defect so a runner crash during DEV downtime doesn't blame the app. */
  if (devHealthy === false) {
    return {
      class: ADJ_CLASS.DEV_INFRA,
      confidence: ADJ_CONFIDENCE.HIGH,
      action: ADJ_ACTION.BREAK_ISSUE, /* caller routes to infra-error, no repo Issue */
      reason: "DEV environment unhealthy — failures are infra-related, not code defects",
    };
  }

  /* Rule 2.5: an attributed 5xx is the app's fault (4xx is ambiguous). Below runner_infra/dev_infra; above isLikelyRealBug. One 5xx is enough (.some, unlike Rule 1's .every) — co-failing cases still appear in the Issue. Not applicable in code mode. */
  const fiveXx = httpStatuses.filter((s): s is number => s !== undefined && s >= 500 && s <= 599);
  if (!isCode && fiveXx.length > 0) {
    const reported = fiveXx[fiveXx.length - 1]!; /* the last (most-recent) attributed 5xx */
    return {
      class: ADJ_CLASS.APP_DEFECT,
      confidence: ADJ_CONFIDENCE.HIGH,
      action: ADJ_ACTION.BREAK_ISSUE,
      reason: `App defect detected: backend returned a 5xx server error (status ${reported}). ${gateReason}`,
    };
  }

  /* Rule 2.6: a captured framework/uncaught runtime error is app evidence even when the failure detail is not a value-mismatch. Below infra/5xx; above isLikelyRealBug. One genuine case is enough. Adds a diagnostic only — never auto-pass or mask a generated-test defect. Empty/benign capture is a no-op. Not applicable in code mode. */
  if (!isCode) {
    for (const errs of runtimeErrorsByCase) {
      const verdict = classifyRuntimeErrors(errs);
      if (verdict.appDefect) {
        return {
          class: ADJ_CLASS.APP_DEFECT,
          confidence: ADJ_CONFIDENCE.HIGH,
          action: ADJ_ACTION.BREAK_ISSUE,
          reason: `App defect detected: browser runtime error captured during the failing test (${verdict.reasons[0]}). ${gateReason}`,
        };
      }
    }
  }

  /* Rule 3: app_defect — same predicate as isLikelyRealBug. allUnique=true + every detail a value-mismatch → real bug. Not applicable in code mode. */
  if (!isCode && isLikelyRealBug(allUnique, failureDetails)) {
    return {
      class: ADJ_CLASS.APP_DEFECT,
      confidence: ADJ_CONFIDENCE.HIGH,
      action: ADJ_ACTION.BREAK_ISSUE,
      reason: `App defect detected: selectors unique + all failures are value mismatches. ${gateReason}`,
    };
  }

  /* Rule 4: generated_test_defect/continue — clear test-side fault AND progress still possible (gateSpend=true). Only fires when not code mode (locators only apply to E2E). Does NOT fire when gateSpend=false → falls through to rule 5 (the asymmetric stop). */
  if (
    !isCode &&
    (absentKeysCount > 0 || failureClasses.every((c) => c === "locator")) &&
    gateSpend === true
  ) {
    return {
      class: ADJ_CLASS.GENERATED_TEST_DEFECT,
      confidence: ADJ_CONFIDENCE.MEDIUM,
      action: ADJ_ACTION.CONTINUE,
      reason: `Test defect: ${absentKeysCount > 0 ? `${absentKeysCount} absent selector(s)` : "all failures are locator errors"} — retrying with grounding feedback`,
    };
  }

  /* Rule 5: break-needs-human — gate is closed and no deterministic class above fired. The asymmetric safety rule: falsely regenerating away a possibly-real failing test is worse than surfacing a labeled Issue for a human to triage. Preserves today's `!gate.spend → break` behaviour but with a labeled Issue. */
  if (gateSpend === false) {
    /* Use the most informative available class for the label. */
    const ambiguousClass = ADJ_CLASS.GENERATED_TEST_DEFECT; /* best label for mixed/other */
    return {
      class: ambiguousClass,
      confidence: ADJ_CONFIDENCE.LOW,
      action: ADJ_ACTION.BREAK_NEEDS_HUMAN,
      reason: `No progress and ambiguous failure — stopping fix-loop for human review. Gate: ${gateReason}`,
    };
  }

  /* Rule 6: objective_gap (inert) — diff mode, zero file-basename overlap between the failing test files and the changed files. Label only; action is always continue. Sits last so it can only attach a label to a verdict that would continue anyway. */
  if (
    !isCode &&
    mode === "diff" &&
    objectiveSource.length > 0 &&
    failingFiles.length > 0 &&
    failingFiles.every((f) => !!f) &&
    noBasenameOverlap(failingFiles as string[], objectiveSource)
  ) {
    return {
      class: ADJ_CLASS.OBJECTIVE_GAP,
      confidence: ADJ_CONFIDENCE.LOW,
      action: ADJ_ACTION.CONTINUE, /* NEVER gates — purely observability */
      reason: "Zero basename overlap between failing test files and changed diff files — possible objective mismatch",
    };
  }

  /* Default: generated_test_defect/low/continue — equivalent to today's fall-through-and- regenerate behaviour (neither branch fired, keep looping). */
  return {
    class: ADJ_CLASS.GENERATED_TEST_DEFECT,
    confidence: ADJ_CONFIDENCE.LOW,
    action: ADJ_ACTION.CONTINUE,
    reason: `Ambiguous failure — continuing fix-loop. Gate: ${gateReason}`,
  };
}


/* True when no basename in `files` overlaps any basename in `sources`. */
function noBasenameOverlap(files: string[], sources: string[]): boolean {
  const bn = (s: string): string => s.replace(/.*\//, "").replace(/.*\\/, "");
  const sourceBasenames = new Set(sources.map(bn));
  return files.every((f) => !sourceBasenames.has(bn(f)));
}
