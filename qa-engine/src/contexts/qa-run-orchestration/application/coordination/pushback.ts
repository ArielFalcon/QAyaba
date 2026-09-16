// External authority checks for DelegationResult (Fase 6). Prompt compliance is not enough.
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
    findings.push({ reason: "foreign-brief", detail: "delegationId/runId mismatch" });
  }
  for (const file of result.filesChanged) {
    if (!isPathWithinWritableRoots(file.path, brief.scope.writablePaths)) {
      findings.push({ reason: "path-outside-scope", detail: file.path });
    }
  }
  // Sidekick cannot claim expanded authority via result metadata — authority is frozen on the brief.
  if (brief.authority.canExpandScope !== SIDEKICK_AUTHORITY.canExpandScope) {
    findings.push({ reason: "authority-violation", detail: "brief authority was mutated" });
  }
  if (result.status === "completed" || result.status === "completed-with-concerns") {
    for (const step of brief.validationPlan) {
      const hit = result.validation.find((v) => v.id === step.id);
      if (!hit) findings.push({ reason: "missing-artifact", detail: `validation ${step.id}` });
      else if (!hit.ok) findings.push({ reason: "acceptance-contradiction", detail: `validation ${step.id} failed` });
    }
    for (const criterion of brief.acceptanceCriteria) {
      const contradicted = result.concerns.some((c) => /accept|criterion|cannot satisfy/i.test(c) && c.includes(criterion));
      if (contradicted) {
        findings.push({ reason: "acceptance-contradiction", detail: criterion });
      }
    }
  }
  if (result.status === "needs-lead" && result.unresolvedQuestions.some((q) => /architect/i.test(q))) {
    findings.push({ reason: "architecture-decision-required", detail: result.unresolvedQuestions.join("; ") });
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
  return {
    ...result,
    status: fatal ? "blocked" : result.status === "completed" ? "completed-with-concerns" : result.status,
    recommendation: fatal ? "escalate" : result.recommendation,
    concerns: [...result.concerns, ...findings.map((f) => `${f.reason}: ${f.detail}`)],
    summary: fatal ? `pushback: ${findings.map((f) => f.reason).join(",")}` : result.summary,
  };
}
