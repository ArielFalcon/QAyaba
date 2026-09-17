// Sidekick prompt assembly. Lives in coordination so generation does not import DelegationBrief
// (no sibling-context dependency). Injected into SidekickExecutor; PromptRenderingPort.renderWorker
// stays intact for the dormant ParallelWorker path.
//
// Free-form brief fields are scrubbed with sanitizeText at this egress — same twin the
// lead/worker prompt builders use for objective/guidance — so secrets never reach the provider.
import { sanitizeText } from "@contexts/generation/infrastructure/sanitize-text.ts";
import type { DelegationBrief } from "./delegation-brief.ts";

function scrub(text: string): string {
  return sanitizeText(text).text;
}

export function renderSidekickBrief(brief: DelegationBrief): {
  text: string;
  sectionSizes: Record<string, number>;
} {
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
      : ["## Acceptance criteria", ...brief.acceptanceCriteria.map((c) => `- ${scrub(c)}`)].join("\n");

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

  const escalation = [
    "## Escalation policy",
    `- onNeedsLead: ${brief.escalationPolicy.onNeedsLead}`,
    `- onNoProgress: ${brief.escalationPolicy.onNoProgress}`,
    `- onBudgetExhausted: ${brief.escalationPolicy.onBudgetExhausted}`,
  ].join("\n");

  const task = [
    "## Task",
    `delegationId: ${brief.delegationId}`,
    `runId: ${brief.runId}`,
    `objective: ${scrub(brief.objective)}`,
    `task: ${scrub(brief.task)}`,
  ].join("\n");

  const contract = [
    "## Output contract",
    "End with ONLY JSON:",
    `{"delegationId":"${brief.delegationId}","runId":"${brief.runId}","status":"completed"|"completed-with-concerns"|"blocked"|"needs-lead"|"failed","summary":"...","filesChanged":[{"path":"..."}],"evidence":[],"validation":[{"id":"...","ok":true}],"assumptions":[],"concerns":[],"unresolvedQuestions":[],"recommendation":"accept"|"review"|"retry"|"escalate"}`,
    "Do NOT write outside writablePaths. Do NOT change acceptance criteria. Prefer needs-lead over inventing architecture.",
  ].join("\n");

  const sections: Record<string, string> = {
    task,
    acceptance,
    scope,
    authority,
    facts,
    artifacts,
    validation,
    escalation,
    contract,
  };
  const text = Object.values(sections).join("\n\n");
  const sectionSizes: Record<string, number> = {};
  for (const [k, v] of Object.entries(sections)) sectionSizes[k] = Buffer.byteLength(v, "utf8");
  return { text, sectionSizes };
}
