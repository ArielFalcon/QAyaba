/* Deterministic process audit: detect that the ENGINE (not the watched app's tests) misbehaved. Only engine-fix becomes a human-gated PR (self-modifying code is never auto-applied). ledger-heal and context-heal are reversible data hygiene; observe is visibility only. */

import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { ErrorClass } from "@contexts/cross-run-learning/application/ports/index.ts";

export type Disposition = "engine-fix" | "ledger-heal" | "context-heal" | "observe";

export interface ProcessFinding {
  kind: string;
  disposition: Disposition;
  severity: "warn" | "error";
  summary: string;
  evidence: string;
  ruleIds?: string[];
  diagnosis?: string;
}

/* Recurring UI/grounding error classes whose likely cause is a STALE/WRONG architecture map — the agent's FE↔BE understanding is off. The cheap, reversible FIRST response is to rebuild the map (context-heal), not to open an engine PR. */
const MAP_GROUNDED_CLASSES = new Set<ErrorClass>(["E-WRONG-OBJECTIVE", "E-FRAGILE-SELECTOR"]);

const ENGINE_DEFECT_CLASSES = new Set<ErrorClass>(["E-STATIC"]);

/* An agent that keeps running out of steps is an operating condition to watch (a prompt, a budget or a change too big for one turn), never an engine defect to patch or a map to rebuild: it is observed and nothing more. */
const STEP_BUDGET_CLASS: ErrorClass = "E-STEP-BUDGET";

/* A run that keeps ending on a login it could not complete is a condition of the app's setup (credentials, a login step no browser can finish): visible to an operator, never an engine defect and never an app-behavior gap a learned rule could close. */
const PRECONDITION_CLASS: ErrorClass = "E-PRECONDITION";

/* Runs that keep ending on their time budget (a generator turn cut off by its tier, or a whole run stopped by its deadline) are an operating condition to watch (a slow DEV, a budget too tight for the changes it meets), never an engine defect to patch or an app-behavior gap a learned rule could close: they are observed and nothing more, and they must never wake the maintainer. */
const TIME_BUDGET_CLASS: ErrorClass = "E-TIME-BUDGET";

/* A reviewer that keeps being unreachable (a model the provider rejects, a runtime that returns nothing) leaves every green run unjudged and unpublished. It is a collaborator's condition to fix, never an engine defect to patch or a rule to learn: it is observed and nothing more, and it must never wake the maintainer. */
const REVIEWER_UNAVAILABLE_CLASS: ErrorClass = "E-REVIEWER-UNAVAILABLE";

/** A minimal view of a learning rule — only the fields the audit reasons about. Narrowing here would be a silent behavioral risk (a real row failing to structurally satisfy this type), not a simplification. */
export interface RuleView {
  id: string;
  errorClass: ErrorClass;
  status: "pending" | "candidate" | "active" | "deprecated" | "superseded";
  usageCount: number;
  successRate: number | null;
}

export interface AuditInput {
  outcome: RunOutcome;
  recent: RunOutcome[];
  rules: RuleView[];
}

/* A run whose triage found the change missing from DEV (the adjudicator's dev_not_rendered class, conclusive or not) is an environment/deploy condition, never a test defect: a streak of them is visible to an operator and nothing more. */
const DEV_NOT_RENDERED_CLASS = "dev_not_rendered";

const RECUR_WINDOW = 3;
const NOISE_USES = 3;
const CHURN_RETRIES = 2;

export function auditProcess(input: AuditInput): ProcessFinding[] {
  const findings: ProcessFinding[] = [];
  const o = input.outcome;
  const cls = o.errorClass;

  /* 1) recurring-error-class. The same non-null errorClass RECUR_WINDOW runs in a row is not bad luck — the engine keeps making the same mistake. The DISPOSITION depends on the class: a recurring UI/grounding error is most cheaply fixed by rebuilding the (likely stale) architecture map (context-heal, autonomous); any other recurring class is a code defect that a map rebuild cannot fix → engine-fix (maintainer PR). Aggregated by design — one occurrence is noise, a streak is the signal. Whether the current errorClass is RECURRING (the same class RECUR_WINDOW runs in a row). Reused by both the recurring-error-class finding and the noise-rule heal (which must only fire when the class a candidate rule targets is the one actually still recurring — see below). */
  const recurringCls: ErrorClass | null = (() => {
    if (!cls) return null;
    const streak = input.recent.slice(0, RECUR_WINDOW);
    return streak.length >= RECUR_WINDOW && streak.every((r) => r.errorClass === cls) ? cls : null;
  })();

  if (recurringCls) {
    const shas = input.recent.slice(0, RECUR_WINDOW).map((r) => r.sha.slice(0, 7)).join(", ");
    const evidence = `last ${RECUR_WINDOW} outcomes errorClass=${recurringCls} (sha ${shas})`;
    /*
     * A dev_not_rendered streak is its own operating signal, above the class branches: the conclusive
     * case ends as E-PRECONDITION, the inconclusive one as a fail, and both belong to the same DEV
     * condition. It is observed and nothing else.
     */
    const devNotRenderedStreak =
      input.recent.slice(0, RECUR_WINDOW).length >= RECUR_WINDOW &&
      input.recent.slice(0, RECUR_WINDOW).every((r) => r.adjudication?.class === DEV_NOT_RENDERED_CLASS);
    if (devNotRenderedStreak) {
      findings.push({
        kind: "recurring-dev-not-rendered",
        disposition: "observe",
        severity: "warn",
        summary: `The change was not rendered on DEV ${RECUR_WINDOW} runs in a row (triage class ${DEV_NOT_RENDERED_CLASS}) — a deploy or environment condition; visibility only, never an engine fix, a learned rule or a maintainer incident.`,
        evidence: `${evidence} adjudication=${DEV_NOT_RENDERED_CLASS}`,
      });
    } else if (MAP_GROUNDED_CLASSES.has(recurringCls)) {
      /* UI/grounding mismatch → rebuild the (likely stale) map first, autonomously. No PR. */
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
        summary: `${recurringCls} ${RECUR_WINDOW} runs in a row — the agent keeps running out of steps without reporting any spec; visibility only, never an engine fix.`,
        evidence,
      });
    } else if (recurringCls === TIME_BUDGET_CLASS) {
      findings.push({
        kind: "recurring-time-exhaustion",
        disposition: "observe",
        severity: "warn",
        summary: `${recurringCls} ${RECUR_WINDOW} runs in a row — the runs keep ending on their time budget (a generator turn or the whole run's deadline); visibility only, never an engine fix or a learned rule.`,
        evidence,
      });
    } else if (recurringCls === REVIEWER_UNAVAILABLE_CLASS) {
      findings.push({
        kind: "recurring-reviewer-unavailable",
        disposition: "observe",
        severity: "warn",
        summary: `${recurringCls} ${RECUR_WINDOW} runs in a row — the reviewer keeps being unreachable or returning nothing, so no green run is judged or published; visibility only, never an engine fix or a learned rule.`,
        evidence,
      });
    } else if (recurringCls === PRECONDITION_CLASS) {
      findings.push({
        kind: "recurring-precondition-failure",
        disposition: "observe",
        severity: "warn",
        summary: `${recurringCls} ${RECUR_WINDOW} runs in a row — the run keeps ending before any test on the app's login; visibility only, never an engine fix or a learned rule.`,
        evidence,
      });
    } else if (ENGINE_DEFECT_CLASSES.has(recurringCls)) {
      findings.push({
        kind: "recurring-error-class",
        disposition: "engine-fix",
        severity: "error",
        summary: `The engine produced ${recurringCls} ${RECUR_WINDOW} runs in a row — a repeating engine defect, not bad luck.`,
        evidence,
      });
    } else {
      findings.push({
        kind: "recurring-test-failure",
        disposition: "observe",
        severity: "warn",
        summary: `${recurringCls} ${RECUR_WINDOW} runs in a row — a recurring app-behavior/learning gap (not an engine defect); needs rule promotion (oracle), not a code PR.`,
        evidence,
      });
    }
  }

  const noisy = recurringCls
    ? input.rules.filter(
        (r) => r.status === "candidate" && r.usageCount >= NOISE_USES && r.errorClass === recurringCls,
      )
    : [];
  if (noisy.length > 0) {
    findings.push({
      kind: "noise-rule",
      disposition: "ledger-heal",
      severity: "warn",
      summary: `${noisy.length} candidate rule(s) used ≥${NOISE_USES}× with zero attribution — deprecating as ledger noise.`,
      evidence: noisy.map((r) => `${r.id}(${r.errorClass}, uses=${r.usageCount})`).join(", "),
      ruleIds: noisy.map((r) => r.id),
    });
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
  deprecateRule: (ruleId: string, reason: string) => void;
  recordEngineIncident: (finding: ProcessFinding) => void; /* engine-fix: → qa-maintainer → human-gated PR */
  invalidateContext: (reason: string) => boolean;
}

export interface AppliedAudit {
  deprecatedRules: string[];
  incidentsRecorded: number;
  contextInvalidated: number;
  observed: number;
}

/** Applies each finding via its disposition — the CODE-vs-DATA boundary made concrete. Only engine-fix becomes a (human-gated) PR; the DATA dispositions self-heal autonomously and reversibly. Returns what it did, for the audit log. */
export function applyAudit(findings: ProcessFinding[], deps: AuditRouterDeps): AppliedAudit {
  const applied: AppliedAudit = { deprecatedRules: [], incidentsRecorded: 0, contextInvalidated: 0, observed: 0 };
  for (const f of findings) {
    switch (f.disposition) {
      case "ledger-heal":
        for (const id of f.ruleIds ?? []) {
          deps.deprecateRule(id, `process-audit/${f.kind}: ${f.summary}`);
          applied.deprecatedRules.push(id);
        }
        deps.log(`[audit] ledger-heal (${f.kind}): deprecated ${f.ruleIds?.length ?? 0} rule(s) — ${f.evidence}`);
        break;
      case "engine-fix":
        deps.recordEngineIncident(f);
        applied.incidentsRecorded++;
        deps.log(`[audit] engine-fix (${f.kind}): recorded an incident for the maintainer (human-gated PR) — ${f.summary}`);
        break;
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
