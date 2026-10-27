/* How a sidekick's answer is read: the last DelegationResult among the JSON objects of its output, checked against the brief it answers, scrubbed, and held to its writable roots. An answer that cannot be read is a failed result marked `readMiss`, never an empty one and never mistaken for a failure the sidekick reported. Free-form fields are scrubbed on parse: they re-enter the lead's context. filesChanged paths are authority inputs (scope check, on-disk adoption) and stay raw; they are scrubbed only where echoed into a summary or concern. */
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { jsonObjectsIn } from "@kernel/last-json-object.ts";
import { UNREADABLE_ANSWER } from "@kernel/unreadable-answer.ts";
import type { DelegationBrief } from "./delegation-brief.ts";
import { ANSWER_MISS, belongsToBrief, CANDIDATE_CLAIMS, DELEGATION_RECOMMENDATIONS, type CandidateClaim, type CandidateClaimStatus, DELEGATION_STATUSES, type AnswerMiss, type DelegationRecommendation, type DelegationResult, type DelegationStatus } from "./delegation-result.ts";
import { readAcceptanceReport } from "./acceptance-report.ts";
import { applyPushback } from "./pushback.ts";
import { isPathWithinWritableRoots } from "./path-scope.ts";

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string");
}

function parseDelegationResult(raw: unknown, brief: DelegationBrief, redaction: RedactionPort): DelegationResult | undefined {
  const scrub = (text: string): string => redaction.redact(text);
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const status = o.status;
  const recommendation = o.recommendation;
  if (typeof o.delegationId !== "string" || typeof o.runId !== "string") return undefined;
  if (typeof status !== "string" || !(DELEGATION_STATUSES as readonly string[]).includes(status)) return undefined;
  if (
    typeof recommendation !== "string" ||
    !(DELEGATION_RECOMMENDATIONS as readonly string[]).includes(recommendation)
  ) {
    return undefined;
  }
  const filesChanged = Array.isArray(o.filesChanged)
    ? o.filesChanged
        .filter((f): f is { path: string } => !!f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string")
        .map((f) => ({ path: f.path }))
    : [];
  const acceptance = readAcceptanceReport(redaction, o.acceptance, brief.acceptanceCriteria.length);
  return {
    delegationId: o.delegationId,
    runId: o.runId,
    status: status as DelegationStatus,
    summary: typeof o.summary === "string" ? scrub(o.summary) : "",
    filesChanged,
    concerns: asStringArray(o.concerns).map(scrub),
    unresolvedQuestions: asStringArray(o.unresolvedQuestions).map(scrub),
    recommendation: recommendation as DelegationRecommendation,
    acceptance: acceptance.entries,
    ...(acceptance.defect ? { acceptanceReportDefect: acceptance.defect } : {}),
    ...candidateClaimsOf(o.candidates, brief, redaction),
    ...testCorrectOf(o.testCorrect, redaction),
  };
}

const MAX_CLAIM_CHARS = 600;
const MAX_CLAIM_SPEC_CHARS = 200;

/* The claims about the use cases the brief listed: a well-formed entry for an id the brief carried, once each; nothing for any other. */
function candidateClaimsOf(value: unknown, brief: DelegationBrief, redaction: RedactionPort): { candidates?: CandidateClaim[] } {
  if (!Array.isArray(value) || !brief.candidates?.length) return {};
  const claims: CandidateClaim[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { id, status, spec } = entry as { id?: unknown; status?: unknown; spec?: unknown };
    if (typeof id !== "string" || !brief.candidates.some((c) => c.id === id) || claims.some((c) => c.id === id)) continue;
    if (typeof status !== "string" || !(CANDIDATE_CLAIMS as readonly string[]).includes(status)) continue;
    const title = typeof spec === "string" ? redaction.redact(spec).trim().slice(0, MAX_CLAIM_SPEC_CHARS) : "";
    claims.push({ id, status: status as CandidateClaimStatus, ...(title !== "" ? { spec: title } : {}) });
  }
  return claims.length > 0 ? { candidates: claims } : {};
}

/* A well-formed test-correct claim, its reason scrubbed and capped; nothing for any other shape. */
function testCorrectOf(value: unknown, redaction: RedactionPort): { testCorrect?: { cause: "env" | "app"; reason: string } } {
  if (!value || typeof value !== "object") return {};
  const { cause, reason } = value as { cause?: unknown; reason?: unknown };
  if ((cause !== "env" && cause !== "app") || typeof reason !== "string" || reason.trim() === "") return {};
  return { testCorrect: { cause, reason: redaction.redact(reason).trim().slice(0, MAX_CLAIM_CHARS) } };
}

function failedResult(brief: DelegationBrief, summary: string, redaction: RedactionPort, answerMiss: AnswerMiss): DelegationResult {
  const safe = redaction.redact(summary);
  return {
    delegationId: brief.delegationId,
    runId: brief.runId,
    status: "failed",
    summary: safe,
    filesChanged: [],
    evidence: [
      {
        id: "sidekick-parse",
        kind: "agent-observation",
        source: "SidekickExecutor",
        summary: safe,
        confidence: "inferred",
      },
    ],
    concerns: [safe],
    unresolvedQuestions: [],
    recommendation: "escalate",
    acceptance: [],
    ...(answerMiss === ANSWER_MISS.UNREADABLE ? { readMiss: UNREADABLE_ANSWER } : {}),
    answerMiss,
  };
}

/* The last object of the output that is a DelegationResult of the contract: an earlier verdict or a quoted payload is not the answer. */
function lastDelegationResult(output: string, brief: DelegationBrief, redaction: RedactionPort): DelegationResult | undefined {
  const objects = jsonObjectsIn(output);
  for (let i = objects.length - 1; i >= 0; i--) {
    const parsed = parseDelegationResult(objects[i], brief, redaction);
    if (parsed) return parsed;
  }
  return undefined;
}

/* The delegation result a sidekick's output came to. */
export function readDelegationResult(output: string, brief: DelegationBrief, redaction: RedactionPort): DelegationResult {
  const parsed = lastDelegationResult(output, brief, redaction);
  if (!parsed) return failedResult(brief, "sidekick output was not a valid DelegationResult", redaction, ANSWER_MISS.UNREADABLE);
  if (!belongsToBrief(parsed, brief.delegationId, brief.runId)) {
    return failedResult(brief, "sidekick result did not belong to this brief", redaction, ANSWER_MISS.FOREIGN_BRIEF);
  }
  const illegal = parsed.filesChanged.filter((f) => !isPathWithinWritableRoots(f.path, brief.scope.writablePaths));
  if (illegal.length > 0) {
    return {
      ...parsed,
      status: "blocked",
      summary: redaction.redact(`write outside writablePaths: ${illegal.map((f) => f.path).join(", ")}`),
      recommendation: "escalate",
      concerns: [...parsed.concerns, redaction.redact(`paths outside scope: ${illegal.map((f) => f.path).join(", ")}`)],
    };
  }
  return applyPushback(brief, parsed);
}
