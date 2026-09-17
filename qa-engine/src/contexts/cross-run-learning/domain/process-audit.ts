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
    if (MAP_GROUNDED_CLASSES.has(recurringCls)) {
      /* UI/grounding mismatch → rebuild the (likely stale) map first, autonomously. No PR. */
      findings.push({
        kind: "recurring-ui-mismatch",
        disposition: "context-heal",
        severity: "warn",
        summary: `${recurringCls} ${RECUR_WINDOW} runs in a row — the architecture map is likely stale; rebuilding it before escalating.`,
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
