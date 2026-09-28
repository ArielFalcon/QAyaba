/* External authority checks for DelegationResult. Prompt compliance is not enough: the brief a result
   answers, its scope, its validation steps and its typed acceptance report are checked here. The
   sidekick's free-text concerns are notes for the lead and never decide anything. */
import { ACCEPTANCE_REPORT_DEFECTS } from "./acceptance-report.ts";
import { SIDEKICK_AUTHORITY } from "./authority.ts";
import type { DelegationBrief } from "./delegation-brief.ts";
import { belongsToBrief, type DelegationResult } from "./delegation-result.ts";
import { isPathWithinWritableRoots } from "./path-scope.ts";

export const PUSHBACK_REASONS = [
  "missing-artifact",
  "acceptance-contradiction",
  "insufficient-scope",
  "architecture-decision-required",
  "dependency-unavailable",
  "path-outside-scope",
  "foreign-brief",
  "authority-violation",
  ...ACCEPTANCE_REPORT_DEFECTS,
] as const;
export type PushbackReason = (typeof PUSHBACK_REASONS)[number];

export interface PushbackFinding {
  readonly reason: PushbackReason;
  readonly detail: string;
}

export function validateDelegationAuthority(
  brief: DelegationBrief,
  result: DelegationResult,
): PushbackFinding[] {
  const findings: PushbackFinding[] = [];
  if (!belongsToBrief(result, brief.delegationId, brief.runId)) {
    findings.push({ reason: "foreign-brief", detail: `${result.delegationId}/${result.runId}` });
  }
  for (const file of result.filesChanged) {
    if (!isPathWithinWritableRoots(file.path, brief.scope.writablePaths)) {
      findings.push({ reason: "path-outside-scope", detail: file.path });
    }
  }
  /* Sidekick cannot claim expanded authority via result metadata — authority is frozen on the brief. */
  if (brief.authority.canExpandScope !== SIDEKICK_AUTHORITY.canExpandScope) {
    findings.push({ reason: "authority-violation", detail: `canExpandScope=${brief.authority.canExpandScope}` });
  }
  if (result.status === "completed" || result.status === "completed-with-concerns") {
    for (const step of brief.validationPlan) {
      const hit = result.validation.find((v) => v.id === step.id);
      if (!hit) findings.push({ reason: "missing-artifact", detail: `validation ${step.id}` });
      else if (!hit.ok) findings.push({ reason: "acceptance-contradiction", detail: `validation ${step.id} failed` });
    }
    /* A criterion the sidekick itself reports unmet contradicts acceptance; met and unverified never block. */
    for (const entry of result.acceptance) {
      if (entry.status === "unmet") {
        findings.push({
          reason: "acceptance-contradiction",
          detail: `criterion ${entry.criterion}: ${brief.acceptanceCriteria[entry.criterion - 1]}`,
        });
      }
    }
  }
  /* A missing or malformed acceptance report breaks the output contract without proving any
     criterion unmet: a non-fatal finding, whatever the status. */
  if (result.acceptanceReportDefect) {
    findings.push({ reason: result.acceptanceReportDefect.reason, detail: result.acceptanceReportDefect.detail });
  }
  if (result.status === "needs-lead") {
    for (const question of result.unresolvedQuestions) {
      if (/architect/i.test(question)) findings.push({ reason: "architecture-decision-required", detail: question });
    }
  }
  if (result.status === "blocked" && /dependenc/i.test(result.summary)) {
    findings.push({ reason: "dependency-unavailable", detail: result.summary });
  }
  if (result.status === "blocked" && /scope/i.test(result.summary)) {
    findings.push({ reason: "insufficient-scope", detail: result.summary });
  }
  return findings;
}

export function applyPushback(brief: DelegationBrief, result: DelegationResult): DelegationResult {
  const findings = validateDelegationAuthority(brief, result);
  if (findings.length === 0) return result;
  const fatal = findings.some((f) =>
    f.reason === "foreign-brief" ||
    f.reason === "path-outside-scope" ||
    f.reason === "authority-violation" ||
    f.reason === "acceptance-contradiction",
  );
  const reasonList = findings.map((f) => f.reason).join(",");
  return {
    ...result,
    status: fatal ? "blocked" : result.status === "completed" ? "completed-with-concerns" : result.status,
    recommendation: fatal ? "escalate" : result.recommendation,
    concerns: [...result.concerns, ...findings.map((f) => `${f.reason}: ${f.detail}`)],
    summary: fatal ? `pushback: ${reasonList}` : result.summary,
  };
}
