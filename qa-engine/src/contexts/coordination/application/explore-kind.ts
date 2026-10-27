/* The explore kind's brief and answer: the brief names one question and the pages to look at; the answer is the result contract of `agents/agent/qa-explore.md`, read as untrusted input, scrubbed, and held to its caps. An answer that cannot be read is a failed result, never an empty one. */
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import type { DelegationBrief } from "./delegation-brief.ts";
import type { DelegationResult } from "./delegation-result.ts";
import { lastJsonObjectWhere } from "@kernel/last-json-object.ts";
import { assembleDefs, type AssembledPrompt } from "@kernel/prompt-sections.ts";
import { EXPLORE_BRIEF_SECTIONS } from "./coordination-sections/brief-sections.ts";
import { exploreDelegationId, questionIdOf } from "./coordination-sections/explore-ids.ts";
import { EXPLORE_FINDING_KIND, EXPLORE_STATUS, MAX_FINDING_CHARS, MAX_FINDINGS, MAX_REF_CHARS, type ExploreFinding, type ExploreFindingKind, type ExploreStatus } from "./exploration.ts";

const KINDS: readonly string[] = Object.values(EXPLORE_FINDING_KIND);
const STATUSES: readonly string[] = Object.values(EXPLORE_STATUS);

export { exploreDelegationId, questionIdOf };

/* The explore sidekick's brief, assembled from the registered sections, with everything the assembler reports. */
export function assembleExploreBrief(redaction: RedactionPort, brief: DelegationBrief): AssembledPrompt {
  return assembleDefs(EXPLORE_BRIEF_SECTIONS, { brief, scrub: (value) => redaction.redact(value) }, { separator: "\n\n" });
}

export function renderExploreBrief(redaction: RedactionPort, brief: DelegationBrief): { text: string; sectionSizes: Record<string, number>; sectionHashes: Record<string, string> } {
  const { text, sectionSizes, sectionHashes } = assembleExploreBrief(redaction, brief);
  return { text, sectionSizes, sectionHashes: sectionHashes ?? {} };
}

function failed(brief: DelegationBrief, summary: string, redaction: RedactionPort): DelegationResult {
  const safe = redaction.redact(summary);
  return {
    delegationId: brief.delegationId,
    runId: brief.runId,
    status: "failed",
    summary: safe,
    filesChanged: [],
    evidence: [],
    validation: [],
    assumptions: [],
    concerns: [safe],
    unresolvedQuestions: [],
    recommendation: "escalate",
    acceptance: [],
  };
}

function findingOf(raw: unknown, redaction: RedactionPort): ExploreFinding | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.kind !== "string" || !KINDS.includes(o.kind)) return undefined;
  const cut = (value: unknown, max: number): string => (typeof value === "string" ? redaction.redact(value).replace(/\s+/g, " ").trim().slice(0, max) : "");
  const claim = cut(o.claim, MAX_FINDING_CHARS);
  const ref = cut(o.ref, MAX_REF_CHARS);
  if (claim === "" || ref === "") return undefined;
  return { claim, kind: o.kind as ExploreFindingKind, ref, evidence: cut(o.evidence, MAX_FINDING_CHARS) };
}

/* The delegation result an explore sidekick's output came to; the findings it kept ride on `exploration`. */
export function readExploreResult(redaction: RedactionPort, output: string, brief: DelegationBrief): DelegationResult {
  const raw = lastJsonObjectWhere(output, (o) => Array.isArray(o.findings) || typeof o.id === "string");
  if (typeof raw !== "object" || raw === null) return failed(brief, "explore output was not a valid exploration result", redaction);
  const o = raw as Record<string, unknown>;
  if (o.id !== questionIdOf(brief.delegationId)) return failed(brief, "explore result did not belong to this question", redaction);
  if (typeof o.status !== "string" || !STATUSES.includes(o.status) || !Array.isArray(o.findings)) return failed(brief, "explore output was not a valid exploration result", redaction);
  const findings = o.findings.slice(0, MAX_FINDINGS).flatMap((entry) => {
    const finding = findingOf(entry, redaction);
    return finding ? [finding] : [];
  });
  const status = o.status as ExploreStatus;
  return {
    delegationId: brief.delegationId,
    runId: brief.runId,
    status: status === EXPLORE_STATUS.ANSWERED ? "completed" : "completed-with-concerns",
    summary: "",
    filesChanged: [],
    evidence: [],
    validation: [],
    assumptions: [],
    concerns: [],
    unresolvedQuestions: [],
    recommendation: "accept",
    acceptance: [],
    exploration: { id: o.id, status, findings },
  };
}
