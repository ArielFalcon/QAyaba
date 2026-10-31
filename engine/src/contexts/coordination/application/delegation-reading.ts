/* How a sidekick's answer is read: the object that closes its output, when it is shaped as a DelegationResult, checked against the brief it answers, scrubbed, and held to its writable roots. Its lists are read by the one reader of an answer (`answer-reading.ts`): an entry that cannot be read as the contract says is recorded in `unreadableEntries` and not acted on, never defaulted. An answer that cannot be read is a failed result marked `readMiss`, never an empty one and never mistaken for a failure the sidekick reported. Free-form fields are scrubbed on parse: they re-enter the lead's context. filesChanged paths are authority inputs (scope check, on-disk adoption) and stay raw; they are scrubbed only where echoed into a summary or concern. */
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { closingJsonObject } from "@kernel/last-json-object.ts";
import { UNREADABLE_ANSWER } from "@kernel/unreadable-answer.ts";
import type { DelegationBrief } from "./delegation-brief.ts";
import { ANSWER_MISS, belongsToBrief, CANDIDATE_CLAIMS, type CandidateClaim, type CandidateClaimStatus, DELEGATION_STATUSES, type AnswerMiss, type DelegationResult, type DelegationStatus } from "./delegation-result.ts";
import { entryRead, entryUnreadable, readEntries, readOneOf, type EntryRead, type UnreadableEntry } from "./answer-reading.ts";
import { readAcceptanceReport } from "./acceptance-report.ts";
import { applyPushback } from "./pushback.ts";
import { backDevStateUnmet, type DevStateGround } from "./dev-state-backing.ts";
import { isPathWithinWritableRoots } from "./path-scope.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseDelegationResult(raw: unknown, brief: DelegationBrief, redaction: RedactionPort): DelegationResult | undefined {
  const scrub = (text: string): string => redaction.redact(text);
  if (!isRecord(raw)) return undefined;
  const o = raw;
  const status = o.status;
  if (typeof o.delegationId !== "string" || typeof o.runId !== "string") return undefined;
  if (typeof status !== "string" || !(DELEGATION_STATUSES as readonly string[]).includes(status)) return undefined;
  const files = readEntries(o.filesChanged, "filesChanged", (f): EntryRead<{ path: string }> => (isRecord(f) && typeof f.path === "string" ? entryRead({ path: f.path }) : entryUnreadable("it is not an object with a path")), scrub, { optional: true });
  const concerns = readEntries(o.concerns, "concerns", stringEntry, scrub, { optional: true });
  const questions = readEntries(o.unresolvedQuestions, "unresolvedQuestions", stringEntry, scrub, { optional: true });
  const acceptance = readAcceptanceReport(redaction, o.acceptance, brief.acceptanceCriteria.length);
  const claims = candidateClaimsOf(o.candidates, brief, redaction);
  const correct = testCorrectOf(o.testCorrect, redaction);
  const unreadable = [...files.unreadable, ...concerns.unreadable, ...questions.unreadable, ...claims.unreadable, ...correct.unreadable];
  return {
    delegationId: o.delegationId,
    runId: o.runId,
    status: status as DelegationStatus,
    summary: typeof o.summary === "string" ? scrub(o.summary) : "",
    filesChanged: files.entries,
    concerns: concerns.entries.map(scrub),
    unresolvedQuestions: questions.entries.map(scrub),
    acceptance: acceptance.entries,
    ...(acceptance.defect ? { acceptanceReportDefect: acceptance.defect } : {}),
    ...(claims.entries.length > 0 ? { candidates: claims.entries } : {}),
    ...(correct.entry ? { testCorrect: correct.entry } : {}),
    ...(unreadable.length > 0 ? { unreadableEntries: unreadable } : {}),
  };
}

const stringEntry = (value: unknown): EntryRead<string> => (typeof value === "string" ? entryRead(value) : entryUnreadable("it is not text"));

const MAX_CLAIM_CHARS = 600;
const MAX_CLAIM_SPEC_CHARS = 200;

/* The claims about the use cases the brief listed: a well-formed entry for an id the brief carried, once each. An entry that is none of those is unreadable; a brief that lists no use case has no claims to read. */
function candidateClaimsOf(value: unknown, brief: DelegationBrief, redaction: RedactionPort): { entries: CandidateClaim[]; unreadable: UnreadableEntry[] } {
  if (value === undefined || !brief.candidates?.length) return { entries: [], unreadable: [] };
  const claimed = new Set<string>();
  const read = readEntries(value, "candidates", (entry): EntryRead<CandidateClaim> => {
    if (!isRecord(entry)) return entryUnreadable("it is not an object");
    const { id, status, spec } = entry;
    if (typeof id !== "string" || !brief.candidates!.some((c) => c.id === id)) return entryUnreadable(`${JSON.stringify(id)} is not a use case of the brief`);
    if (claimed.has(id)) return entryUnreadable(`${id} is claimed twice; the first claim stands`);
    const claim = readOneOf(status, CANDIDATE_CLAIMS, "status");
    if (!claim.ok) return entryUnreadable(`${id}: ${claim.reason}`);
    claimed.add(id);
    const title = typeof spec === "string" ? redaction.redact(spec).trim().slice(0, MAX_CLAIM_SPEC_CHARS) : "";
    return entryRead({ id, status: claim.value as CandidateClaimStatus, ...(title !== "" ? { spec: title } : {}) });
  }, (text) => redaction.redact(text));
  return read;
}

/* A well-formed test-correct claim, its reason scrubbed and capped; absent when the answer makes none, unreadable when it makes one that is not well-formed. */
function testCorrectOf(value: unknown, redaction: RedactionPort): { entry?: { cause: "env" | "app"; reason: string }; unreadable: UnreadableEntry[] } {
  if (value === undefined) return { unreadable: [] };
  const bad = (reason: string) => ({ unreadable: [{ where: "testCorrect", reason }] });
  if (!isRecord(value)) return bad("it is not an object");
  const cause = readOneOf(value.cause, ["env", "app"] as const, "cause");
  if (!cause.ok) return bad(redaction.redact(cause.reason).slice(0, 240));
  if (typeof value.reason !== "string" || value.reason.trim() === "") return bad("reason is missing");
  return { entry: { cause: cause.value, reason: redaction.redact(value.reason).trim().slice(0, MAX_CLAIM_CHARS) }, unreadable: [] };
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
    acceptance: [],
    ...(answerMiss === ANSWER_MISS.UNREADABLE ? { readMiss: UNREADABLE_ANSWER, unreadableEntries: [{ where: "answer", reason: "it holds no result of the contract" }] } : {}),
    answerMiss,
  };
}

/* An object shaped as a delegation result (a status beside the brief's identity), whether or not its values are the contract's. */
const isResultShaped = (o: Record<string, unknown>): boolean => "status" in o && ("delegationId" in o || "runId" in o);

/*
 * The answer is what closes the output: its last object, with nothing after it that opens another. The reader never guesses which of
 * several objects is the answer, so a closing result that does not read (off the contract, not JSON, cut short) or an object of another
 * shape after it is reported unreadable and earns its one repair turn; an earlier result, which the sidekick may have revised, never
 * stands in for it.
 */
function lastDelegationResult(output: string, brief: DelegationBrief, redaction: RedactionPort): { result?: DelegationResult; malformed: boolean } {
  const closing = closingJsonObject(output);
  if (!closing) return { malformed: false };
  if (!isResultShaped(closing)) return { malformed: true };
  const result = parseDelegationResult(closing, brief, redaction);
  return result ? { result, malformed: false } : { malformed: true };
}

/* The delegation result a sidekick's output came to. `ground` is what the orchestrator holds of the flow by its own means: with it, an unmet criterion the sidekick attributes to DEV's state is checked against it; without it, no such claim is backed. */
export function readDelegationResult(output: string, brief: DelegationBrief, redaction: RedactionPort, ground?: DevStateGround): DelegationResult {
  const read = lastDelegationResult(output, brief, redaction);
  const parsed = read.result;
  if (!parsed) return failedResult(brief, read.malformed ? "sidekick's closing result is not of the DelegationResult contract" : "sidekick output was not a valid DelegationResult", redaction, ANSWER_MISS.UNREADABLE);
  if (!belongsToBrief(parsed, brief.delegationId, brief.runId)) {
    return failedResult(brief, "sidekick result did not belong to this brief", redaction, ANSWER_MISS.FOREIGN_BRIEF);
  }
  const illegal = parsed.filesChanged.filter((f) => !isPathWithinWritableRoots(f.path, brief.scope.writablePaths));
  if (illegal.length > 0) {
    return {
      ...parsed,
      status: "blocked",
      summary: redaction.redact(`write outside writablePaths: ${illegal.map((f) => f.path).join(", ")}`),
      concerns: [...parsed.concerns, redaction.redact(`paths outside scope: ${illegal.map((f) => f.path).join(", ")}`)],
    };
  }
  return applyPushback(brief, parsed, ground ? (entry) => backDevStateUnmet(redaction, entry, ground) : undefined);
}
