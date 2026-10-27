/* The explore kind's brief and answer: the brief names one question and the pages to look at; the answer is the result contract of `agents/agent/qa-explore.md`, read as untrusted input, scrubbed, and held to its caps. An answer that cannot be read is a failed result, never an empty one. */
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import type { DelegationBrief } from "./delegation-brief.ts";
import type { DelegationResult } from "./delegation-result.ts";
import { lastJsonObjectWhere } from "@kernel/last-json-object.ts";
import { EXPLORE_FINDING_KIND, EXPLORE_STATUS, MAX_FINDING_CHARS, MAX_FINDINGS, MAX_REF_CHARS, type ExploreFinding, type ExploreFindingKind, type ExploreStatus } from "./exploration.ts";

const KINDS: readonly string[] = Object.values(EXPLORE_FINDING_KIND);
const STATUSES: readonly string[] = Object.values(EXPLORE_STATUS);

/* The question id a delegation id names: `<run>-explore-<id>`. */
export const exploreDelegationId = (runId: string, questionId: string): string => `${runId}-explore-${questionId}`;
export const questionIdOf = (delegationId: string): string => delegationId.replace(/^.*-explore-/, "");

export function renderExploreBrief(redaction: RedactionPort, brief: DelegationBrief): { text: string; sectionSizes: Record<string, number> } {
  const scrub = (value: string): string => redaction.redact(value);
  const id = questionIdOf(brief.delegationId);
  const sections: Record<string, string> = {
    question: ["## Question", `id: ${id}`, scrub(brief.objective)].join("\n"),
    task: ["## Task", scrub(brief.task)].join("\n"),
    ...(brief.knownFacts.length > 0 ? { facts: ["## Known facts", ...brief.knownFacts.map((fact) => `- [${fact.confidence}/${fact.kind}] ${scrub(fact.summary)}`)].join("\n") } : {}),
    ...(brief.artifactRefs.length > 0 ? { artifacts: ["## Artifacts", ...brief.artifactRefs.map((ref) => `- ${ref.id}: ${ref.path}`)].join("\n") } : {}),
    contract: [
      "## Output contract",
      "End with ONLY JSON:",
      `{"id":"${id}","status":"answered"|"unanswered","findings":[{"claim":"...","kind":"page"|"element"|"symbol"|"data-state","ref":"...","evidence":"..."}]}`,
      `At most ${MAX_FINDINGS} findings. A symbol ref is <repo-relative file>#<symbol>; a page or data-state ref is the site-relative path.`,
    ].join("\n"),
  };
  const text = Object.values(sections).join("\n\n");
  const sectionSizes: Record<string, number> = {};
  for (const [key, value] of Object.entries(sections)) sectionSizes[key] = Buffer.byteLength(value, "utf8");
  return { text, sectionSizes };
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
