/* Deterministic process audit: detect that the ENGINE (not the watched app's tests) misbehaved. context-heal is reversible data hygiene; observe is visibility only. */

import type { RunOutcome } from "@kernel/run-outcome.ts";

/* The closed set of error codes lives with the run outcome; the audit reasons about them by name. */
type ErrorClass = string;

export type Disposition = "context-heal" | "observe";

export interface ProcessFinding {
  kind: string;
  disposition: Disposition;
  severity: "warn" | "error";
  summary: string;
  evidence: string;
}

/* Recurring UI/grounding error classes whose likely cause is a STALE/WRONG architecture map — the agent's FE↔BE understanding is off. The cheap, reversible FIRST response is to rebuild the map (context-heal), not to treat it as an engine defect. */
const MAP_GROUNDED_CLASSES = new Set<ErrorClass>(["E-WRONG-OBJECTIVE", "E-FRAGILE-SELECTOR"]);

const ENGINE_DEFECT_CLASSES = new Set<ErrorClass>(["E-STATIC"]);

/* An agent that keeps running out of steps is an operating condition to watch (a prompt, a budget or a change too big for one turn), never an engine defect to patch or a map to rebuild: it is observed and nothing more. */
const STEP_BUDGET_CLASS: ErrorClass = "E-STEP-BUDGET";

/* A run that keeps ending on a login it could not complete is a condition of the app's setup (credentials, a login step no browser can finish): visible to an operator, never an engine defect. */
const PRECONDITION_CLASS: ErrorClass = "E-PRECONDITION";

/* Runs that keep ending on their time budget (a generator turn cut off by its tier, or a whole run stopped by its deadline) are an operating condition to watch (a slow DEV, a budget too tight for the changes it meets), never an engine defect to patch: they are observed and nothing more. */
const TIME_BUDGET_CLASS: ErrorClass = "E-TIME-BUDGET";

/* A reviewer that keeps being unreachable (a model the provider rejects, a runtime that returns nothing) leaves every green run unjudged and unpublished. It is a collaborator's condition to fix, never an engine defect to patch: it is observed and nothing more. */
const REVIEWER_UNAVAILABLE_CLASS: ErrorClass = "E-REVIEWER-UNAVAILABLE";

export interface AuditInput {
  outcome: RunOutcome;
  recent: RunOutcome[];
}

const RECUR_WINDOW = 3;
const CHURN_RETRIES = 2;

export function auditProcess(input: AuditInput): ProcessFinding[] {
  const findings: ProcessFinding[] = [];
  const o = input.outcome;
  const cls = o.errorClass;

  /* 1) recurring-error-class. The same non-null errorClass RECUR_WINDOW runs in a row is not bad luck — the engine keeps making the same mistake. The DISPOSITION depends on the class: a recurring UI/grounding error is most cheaply fixed by rebuilding the (likely stale) architecture map (context-heal, autonomous); any other recurring class is a code defect that a map rebuild cannot fix → observed (visibility only). Aggregated by design — one occurrence is noise, a streak is the signal. Whether the current errorClass is RECURRING (the same class RECUR_WINDOW runs in a row). */
  const recurringCls: ErrorClass | null = (() => {
    if (!cls) return null;
    const streak = input.recent.slice(0, RECUR_WINDOW);
    return streak.length >= RECUR_WINDOW && streak.every((r) => r.errorClass === cls) ? cls : null;
  })();

  if (recurringCls) {
    const shas = input.recent.slice(0, RECUR_WINDOW).map((r) => r.sha.slice(0, 7)).join(", ");
    const evidence = `last ${RECUR_WINDOW} outcomes errorClass=${recurringCls} (sha ${shas})`;
    if (MAP_GROUNDED_CLASSES.has(recurringCls)) {
      /* UI/grounding mismatch → rebuild the (likely stale) map first, autonomously. */
      findings.push({
        kind: "recurring-ui-mismatch",
        disposition: "context-heal",
        severity: "warn",
        summary: `${recurringCls} ${RECUR_WINDOW} runs in a row — the architecture map is likely stale; rebuilding it before escalating.`,
        evidence,
      });
    } else if (recurringCls === STEP_BUDGET_CLASS) {
      findings.push({
        kind: "recurring-step-exhaustion",
        disposition: "observe",
        severity: "warn",
        /* mutation-scope:begin recurring-class-summary */
        summary: `${recurringCls} ${RECUR_WINDOW} runs in a row — the agent keeps running out of steps without reporting any spec; visibility only, never an engine fix.`,
        evidence,
      });
    } else if (recurringCls === TIME_BUDGET_CLASS) {
      findings.push({
        kind: "recurring-time-exhaustion",
        disposition: "observe",
        severity: "warn",
        /* mutation-scope:end recurring-class-summary */
        summary: `${recurringCls} ${RECUR_WINDOW} runs in a row — the runs keep ending on their time budget (a generator turn or the whole run's deadline); visibility only, never an engine fix.`,
        evidence,
      });
    } else if (recurringCls === REVIEWER_UNAVAILABLE_CLASS) {
      findings.push({
        kind: "recurring-reviewer-unavailable",
        disposition: "observe",
        severity: "warn",
        summary: `${recurringCls} ${RECUR_WINDOW} runs in a row — the reviewer keeps being unreachable or returning nothing, so no green run is judged or published; visibility only, never an engine fix.`,
        evidence,
      });
    } else if (recurringCls === PRECONDITION_CLASS) {
      findings.push({
        kind: "recurring-precondition-failure",
        disposition: "observe",
        severity: "warn",
        summary: `${recurringCls} ${RECUR_WINDOW} runs in a row — the run keeps ending before any test on the app's login; visibility only, never an engine fix.`,
        evidence,
      });
    } else if (ENGINE_DEFECT_CLASSES.has(recurringCls)) {
      findings.push({
        kind: "recurring-error-class",
        disposition: "observe",
        severity: "error",
        summary: `The engine produced ${recurringCls} ${RECUR_WINDOW} runs in a row — a repeating engine defect, not bad luck.`,
        evidence,
      });
    } else {
      findings.push({
        kind: "recurring-test-failure",
        disposition: "observe",
        severity: "warn",
        summary: `${recurringCls} ${RECUR_WINDOW} runs in a row — a recurring app-behavior gap (not an engine defect), not a code PR.`,
        evidence,
      });
    }
  }

  if ((o.gateSignals.retries ?? 0) >= CHURN_RETRIES && o.verdict !== "pass") {
    findings.push({
      kind: "review-churn-no-gain",
      disposition: "observe",
      severity: "warn",
      summary: `${o.gateSignals.retries} regeneration round(s) and the run still ended ${o.verdict} — the review cycles did not pay off.`,
      evidence: `retries=${o.gateSignals.retries}, verdict=${o.verdict}, reviewerApproved=${o.gateSignals.reviewerApproved ?? "n/a"}`,
    });
  }

  return findings;
}

export interface AuditRouterDeps {
  log: (line: string) => void;
  invalidateContext: (reason: string) => boolean;
}

export interface AppliedAudit {
  contextInvalidated: number;
  observed: number;
}

/** Applies each finding via its disposition — the CODE-vs-DATA boundary made concrete. The DATA disposition self-heals autonomously and reversibly; observe only logs. Returns what it did, for the audit log. */
export function applyAudit(findings: ProcessFinding[], deps: AuditRouterDeps): AppliedAudit {
  const applied: AppliedAudit = { contextInvalidated: 0, observed: 0 };
  for (const f of findings) {
    switch (f.disposition) {
      case "context-heal": {
        const acted = deps.invalidateContext(`process-audit/${f.kind}: ${f.summary}`);
        if (acted) applied.contextInvalidated++;
        deps.log(`[audit] context-heal (${f.kind}): ${acted ? "invalidated the architecture map — it rebuilds next run" : "no map to invalidate"} — ${f.evidence}`);
        break;
      }
      case "observe":
        applied.observed++;
        deps.log(`[audit] observe (${f.kind}): ${f.summary}`);
        break;
    }
  }
  return applied;
}
