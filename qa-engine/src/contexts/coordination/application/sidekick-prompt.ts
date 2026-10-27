/* Sidekick prompt assembly lives here so generation does not import DelegationBrief. Injected into SidekickExecutor.
Free-form brief fields are redacted through the RedactionPort at this egress, so secrets never reach the provider. */
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { harnessFactLines } from "@contexts/generation/application/index.ts";
import type { BriefCandidate, DelegationBrief } from "./delegation-brief.ts";
import { ACCEPTANCE_STATUSES } from "./acceptance-report.ts";
import { CANDIDATE_CLAIMS } from "./delegation-result.ts";

/* The use cases this flow must exercise: where the change reaches each, the changed code, and where the expected behavior comes from. */
function changeSection(candidates: readonly BriefCandidate[], scrub: (text: string) => string): string {
  return [
    "## Change this flow must exercise",
    "Expected values come from the contract or the commit's stated intent, never from what the page shows: a page that already shows the new behavior proves nothing about the change.",
    ...candidates.flatMap((candidate) => [
      `### ${candidate.id}: ${scrub(candidate.entry)} (${candidate.tier})`,
      candidate.evidence.length > 0 ? `Reached through: ${candidate.evidence.map(scrub).join(" > ")}` : "",
      candidate.symbols.length > 0 ? `Changed symbols: ${candidate.symbols.map(scrub).join("; ")}` : "",
      `Expected behavior comes from: ${candidate.expectedFrom.map((source) => `${source.kind} (${scrub(source.ref)})`).join("; ")}`,
      ...candidate.hunks.map((hunk) => ["Changed code:", "```diff", scrub(hunk), "```"].join("\n")),
    ].filter(Boolean)),
  ].join("\n");
}

/* How many suite lines a brief lists, and the longest of them; the rest are counted. */
export const BRIEF_MAX_SUITE_LINES = 30;
export const BRIEF_MAX_SUITE_LINE_CHARS = 300;

const harnessSection = (brief: DelegationBrief, scrub: (text: string) => string): string | undefined => {
  const lines = brief.harnessFacts ? harnessFactLines(brief.harnessFacts, brief.specRelDir ?? "e2e", scrub) : [];
  return lines.length > 0 ? ["## Harness facts", ...lines].join("\n") : undefined;
};

const suiteSection = (suite: readonly string[] | undefined, scrub: (text: string) => string): string | undefined => {
  if (suite === undefined || suite.length === 0) return undefined;
  const shown = suite.slice(0, BRIEF_MAX_SUITE_LINES).map((line) => {
    const flat = scrub(line).replace(/\s+/g, " ").trim();
    return `- ${flat.length > BRIEF_MAX_SUITE_LINE_CHARS ? `${flat.slice(0, BRIEF_MAX_SUITE_LINE_CHARS - 1)}…` : flat}`;
  });
  const more = suite.length - shown.length;
  return ["## Specs the suite already holds", ...shown, ...(more > 0 ? [`(+${more} more)`] : [])].join("\n");
};

export function renderSidekickBrief(redaction: RedactionPort, brief: DelegationBrief): {
  text: string;
  sectionSizes: Record<string, number>;
} {
  const scrub = (text: string): string => redaction.redact(text);
  const authority = [
    "## Authority (frozen — you cannot raise these)",
    `- canModifyArchitecture: ${brief.authority.canModifyArchitecture}`,
    `- canChangeAcceptanceCriteria: ${brief.authority.canChangeAcceptanceCriteria}`,
    `- canExpandScope: ${brief.authority.canExpandScope}`,
    `- canChallengeBrief: ${brief.authority.canChallengeBrief}`,
  ].join("\n");

  const scope = [
    "## Scope",
    `- readablePaths: ${brief.scope.readablePaths.join(", ") || "(none)"}`,
    `- writablePaths: ${brief.scope.writablePaths.join(", ") || "(none)"}`,
    `- allowedCommands: ${brief.scope.allowedCommands.join(", ") || "(none)"}`,
  ].join("\n");

  const acceptance =
    brief.acceptanceCriteria.length === 0
      ? "## Acceptance criteria\n(none)"
      : ["## Acceptance criteria", ...brief.acceptanceCriteria.map((c, i) => `${i + 1}. ${scrub(c)}`)].join("\n");

  const facts =
    brief.knownFacts.length === 0
      ? "## Known facts\n(none)"
      : [
          "## Known facts",
          ...brief.knownFacts.map((f) => `- [${f.confidence}/${f.kind}] ${scrub(f.summary)}`),
        ].join("\n");

  const artifacts =
    brief.artifactRefs.length === 0
      ? "## Artifacts\n(none)"
      : ["## Artifacts", ...brief.artifactRefs.map((a) => `- ${a.id}: ${a.path}`)].join("\n");

  const validation =
    brief.validationPlan.length === 0
      ? "## Validation plan\n(none)"
      : [
          "## Validation plan",
          ...brief.validationPlan.map((v) => `- ${v.id}: ${scrub(v.description)}`),
        ].join("\n");

  const task = [
    "## Task",
    `delegationId: ${brief.delegationId}`,
    `runId: ${brief.runId}`,
    `objective: ${scrub(brief.objective)}`,
    `task: ${scrub(brief.task)}`,
  ].join("\n");

  const withCandidates = brief.candidates !== undefined && brief.candidates.length > 0;
  const contract = [
    "## Output contract",
    "End with ONLY JSON:",
    `{"delegationId":"${brief.delegationId}","runId":"${brief.runId}","status":"completed"|"completed-with-concerns"|"blocked"|"needs-lead"|"failed","summary":"...","filesChanged":[{"path":"..."}],"evidence":[],"validation":[{"id":"...","ok":true}],"acceptance":[{"criterion":1,"status":${ACCEPTANCE_STATUSES.map((st) => JSON.stringify(st)).join("|")},"note":"..."}],${withCandidates ? `"candidates":[{"id":"uc-...","status":${CANDIDATE_CLAIMS.map((st) => JSON.stringify(st)).join("|")},"spec":"<test title>"}],` : ""}"assumptions":[],"concerns":[],"unresolvedQuestions":[],"recommendation":"accept"|"review"|"retry"|"escalate"}`,
    "acceptance: one entry for every numbered acceptance criterion, by its number: met only when you checked it holds, unmet when your work does not satisfy it, unverified when you could not check it; [] when there are none. Only an unmet entry reports a failure — concerns are notes.",
    ...(withCandidates ? ["candidates: one entry for every use case of the Change section, by its id: covered when a test of yours exercises it, not-covered when none does, blocked when you could not. It is your claim; the orchestrator's own run of the spec decides."] : []),
    "This is the only closing JSON of your turn: no other verdict object (such as one with a `specs` list) comes with or after it.",
    "Do NOT write outside writablePaths. Do NOT change acceptance criteria. Prefer needs-lead over inventing architecture.",
  ].join("\n");

  const sections: Record<string, string> = {
    task,
    acceptance,
    scope,
    authority,
    facts,
    ...(harnessSection(brief, scrub) ? { harness: harnessSection(brief, scrub)! } : {}),
    ...(suiteSection(brief.suite, scrub) ? { suite: suiteSection(brief.suite, scrub)! } : {}),
    ...(brief.pages ? { pages: ["## Pages of this flow (from the run's Context Pack)", brief.pages].join("\n") } : {}),
    ...(brief.proofs?.length ? { proofs: ["## How the change reaches this flow's pages (from the run's call graph)", ...brief.proofs.map((proof) => `- ${scrub(proof)}`)].join("\n") } : {}),
    ...(withCandidates ? { change: changeSection(brief.candidates!, scrub) } : {}),
    artifacts,
    validation,
    contract,
  };
  const text = Object.values(sections).join("\n\n");
  const sectionSizes: Record<string, number> = {};
  for (const [k, v] of Object.entries(sections)) sectionSizes[k] = Buffer.byteLength(v, "utf8");
  return { text, sectionSizes };
}
