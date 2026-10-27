/* External authority checks for DelegationResult. Prompt compliance is not enough: the brief a result
   answers, its scope and its typed acceptance report are checked here. The
   sidekick's free-text concerns are notes for the lead and never decide anything. */
import { ACCEPTANCE_REPORT_DEFECTS, type AcceptanceReportEntry } from "./acceptance-report.ts";
import { SIDEKICK_AUTHORITY } from "./authority.ts";
import type { DelegationBrief } from "./delegation-brief.ts";
import { belongsToBrief, type DelegationResult, type UnmetByDevState } from "./delegation-result.ts";
import type { DevStateBacking } from "./explore-verification.ts";
import { isPathWithinWritableRoots } from "./path-scope.ts";

export const PUSHBACK_REASONS = [
  "acceptance-contradiction",
  "acceptance-unmet-dev-state",
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

/* Whether the orchestrator's own facts back an unmet criterion's claim that DEV's state prevents it. Absent, nothing is backed. */
export type DevStateBacker = (entry: AcceptanceReportEntry) => DevStateBacking;

interface Assessment {
  readonly findings: PushbackFinding[];
  readonly unmetByDevState: UnmetByDevState[];
}

export function validateDelegationAuthority(
  brief: DelegationBrief,
  result: DelegationResult,
  backer?: DevStateBacker,
): PushbackFinding[] {
  return assess(brief, result, backer).findings;
}

function assess(brief: DelegationBrief, result: DelegationResult, backer?: DevStateBacker): Assessment {
  const findings: PushbackFinding[] = [];
  const unmetByDevState: UnmetByDevState[] = [];
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
    /* A criterion the sidekick itself reports unmet contradicts acceptance, whatever the shape of its
       report; met and unverified never block. The one exception is an unmet it attributes to DEV's state
       that the orchestrator's own facts back: DEV cannot be brought to the state the criterion needs, so
       the sidekick is not contradicting acceptance and the result carries a concern naming the fact. */
    for (const entry of result.acceptance) {
      if (entry.status !== "unmet") continue;
      const criterion = `criterion ${entry.criterion}: ${brief.acceptanceCriteria[entry.criterion - 1]}`;
      const backing = entry.devState !== undefined && backer ? backer(entry) : undefined;
      if (entry.devState !== undefined && backing?.backed) {
        findings.push({ reason: "acceptance-unmet-dev-state", detail: `${criterion} (backed by: ${backing.fact})` });
        unmetByDevState.push({ criterion: entry.criterion, pages: entry.devState.pages, backing: backing.fact });
      } else {
        findings.push({ reason: "acceptance-contradiction", detail: criterion });
      }
    }
    for (const claim of result.acceptanceReportDefect?.unmet ?? []) {
      findings.push({ reason: "acceptance-contradiction", detail: claim });
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
  return { findings, unmetByDevState };
}

export function applyPushback(brief: DelegationBrief, result: DelegationResult, backer?: DevStateBacker): DelegationResult {
  const { findings, unmetByDevState } = assess(brief, result, backer);
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
    ...(unmetByDevState.length > 0 && !fatal ? { unmetByDevState } : {}),
  };
}
