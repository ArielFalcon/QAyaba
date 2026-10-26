/*
 * The one round of exploration a lead may ask for before it plans: read-only sidekicks, one per question, run in parallel through
 * the dispatcher inside the time the run can spare; each finding is checked against what the orchestrator itself holds, and the
 * lead is given the findings labelled by that check. Nothing here decides a plan or a verdict: it returns the text of the lead's
 * next turn. A question whose sidekick could not answer is reported to the lead as unanswered, never dropped.
 */
import type { AgentBrowserHandle, CodeGraphToolsHandle } from "@contexts/agent-tools/application/index.ts";
import { packPagesFor } from "@contexts/generation/application/index.ts";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { createDelegationBrief, type DelegationBrief } from "./delegation-brief.ts";
import type { DelegationResult } from "./delegation-result.ts";
import { evidenceFromPackDataRoutes } from "./evidence-from.ts";
import { EXPLORE_STATUS, type Exploration } from "./exploration.ts";
import { EXPLORE_BUDGET_MS, EXPLORE_CALL_SHARE, MIN_EXPLORE_MS, type ExploreQuestion } from "./explore-request.ts";
import { exploreDelegationId } from "./explore-kind.ts";
import { FINDING_VERIFICATION, verifyExplorationFindings, type VerifiedExploration } from "./explore-verification.ts";
import { FLOW_RESULT, type FanOutDispatcher } from "./fan-out-dispatcher.ts";
import { SIDEKICK_KIND } from "./sidekick-kinds.ts";
import type { SidekickExecutor } from "./sidekick-executor.ts";

export interface ExploreRoundDeps {
  redaction: RedactionPort;
  sidekick: Pick<SidekickExecutor, "open">;
  dispatcher: FanOutDispatcher;
  /* Whether the run's code graph holds the symbol a finding's ref names (`<file>#<symbol>`, or a route's target symbol); absent: no symbol finding is verified. */
  graphHolds?(ref: string): Promise<boolean>;
  record(event: { reason: string; delegationId: string; durationMs?: number; sidekickStatus?: string; failureClass?: string }): void;
  now(): number;
  log?(text: string): void;
}

export interface ExploreRoundInput {
  runId: string;
  mirrorDir: string;
  questions: readonly ExploreQuestion[];
  /* What the run can spare for the round, after the time it keeps for what follows; absent: the run has no deadline. */
  spareMs: number | undefined;
  signal?: AbortSignal;
  agentBrowser?: AgentBrowserHandle;
  codeGraph?: CodeGraphToolsHandle;
  contextPack?: string;
  confirmedDataRoutes?: readonly { path: string; resultCount: number }[];
  devBaseUrl?: string;
}

/* What the round came to for the lead: the findings of every question, verified or labelled, in the order asked. */
export interface ExploreOutcome {
  /* Whether any sidekick ran. */
  ran: boolean;
  questions: VerifiedExploration[];
  /* Why no sidekick ran, when none did. */
  skipped?: string;
}

const taskOf = (question: ExploreQuestion, browser: boolean, graph: boolean): string =>
  [
    `Answer ONE question for the lead, read-only: ${question.question}`,
    question.routes.length > 0 ? `Pages to look at: ${question.routes.join(", ")}` : "",
    graph ? "You may walk the code graph (codegraph_explore)." : "You have no code graph in this run.",
    browser ? "You may read DEV through the authenticated browser (authbrowser_*); it never writes." : "You have no authenticated browser in this run.",
    "Report only what you read or saw, as the result contract says.",
  ].filter(Boolean).join("\n");

function briefOf(deps: ExploreRoundDeps, input: ExploreRoundInput, question: ExploreQuestion, delegationId: string): DelegationBrief {
  const browser = input.agentBrowser !== undefined;
  const graph = input.codeGraph !== undefined;
  return createDelegationBrief({
    redaction: deps.redaction,
    delegationId,
    runId: input.runId,
    objective: question.question,
    task: taskOf(question, browser, graph),
    scope: { readablePaths: ["."], writablePaths: [], allowedCommands: [] },
    knownFacts: input.confirmedDataRoutes?.length ? evidenceFromPackDataRoutes(deps.redaction, input.confirmedDataRoutes) : [],
    ...(input.devBaseUrl ? { artifactRefs: [{ id: "dev-base-url", path: input.devBaseUrl }] } : {}),
  });
}

const failedExploration = (question: ExploreQuestion): Exploration => ({ id: question.id, status: EXPLORE_STATUS.UNANSWERED, findings: [] });

export async function runExploreRound(deps: ExploreRoundDeps, input: ExploreRoundInput): Promise<ExploreOutcome> {
  const { questions } = input;
  const notRun = (reason: string): ExploreOutcome => ({ ran: false, questions: questions.map((q) => ({ id: q.id, question: q.question, status: "failed", findings: [] })), skipped: reason });
  if (!input.agentBrowser && !input.codeGraph) return notRun("this run holds neither the code graph nor the authenticated browser");
  const budgetMs = input.spareMs === undefined ? EXPLORE_BUDGET_MS : Math.min(EXPLORE_BUDGET_MS, Math.floor(input.spareMs));
  if (budgetMs < MIN_EXPLORE_MS) return notRun("too little of the run is left to explore");

  const slots = questions.map((question) => ({ id: question.id, budgetMs, question, delegationId: exploreDelegationId(input.runId, question.id) }));
  const share = (total: number): number => Math.floor((total * EXPLORE_CALL_SHARE) / questions.length);
  const answers = new Map<string, DelegationResult>();
  const results = await deps.dispatcher.run(slots, { maxParallel: slots.length, ...(input.signal ? { signal: input.signal } : {}) }, async (slot, signal) => {
    input.agentBrowser?.grantShare(slot.delegationId, share(input.agentBrowser.limits.maxCalls));
    input.codeGraph?.grantShare(slot.delegationId, share(input.codeGraph.limits.maxCalls));
    const started = deps.now();
    const session = await deps.sidekick.open(briefOf(deps, input, slot.question, slot.delegationId), {
      cwd: input.mirrorDir,
      kind: SIDEKICK_KIND.EXPLORE,
      signal,
      timeoutMs: Math.max(1, slot.budgetMs),
      delegationId: slot.delegationId,
    });
    await session.dispose().catch((err: unknown) => console.error(`[qa] closing explore session ${slot.delegationId} failed: ${err instanceof Error ? err.message : String(err)}`));
    deps.record({ reason: `explore ${slot.id}: ${session.first.status}`, delegationId: slot.delegationId, durationMs: deps.now() - started, sidekickStatus: session.first.status });
    answers.set(slot.id, session.first);
    return session.first;
  });

  /* The symbols the orchestrator's graph holds, resolved once per ref before the pure check. */
  const held = new Set<string>();
  const ground = (id: string) => ({
    redaction: deps.redaction,
    packReadsPage: (path: string) => packPagesFor(input.contextPack, [path]) !== undefined,
    dataRoutes: input.confirmedDataRoutes ?? [],
    browserReads: input.agentBrowser?.readsOf(exploreDelegationId(input.runId, id)) ?? [],
    graphHolds: (ref: string) => held.has(ref),
  });
  for (const answer of answers.values()) {
    for (const finding of answer.exploration?.findings ?? []) {
      if (finding.kind === "symbol" && deps.graphHolds && !held.has(finding.ref) && (await deps.graphHolds(finding.ref).catch(() => false))) held.add(finding.ref);
    }
  }
  const outcome: VerifiedExploration[] = [];
  for (const question of questions) {
    const result = results.find((r) => r.id === question.id);
    const answer = result?.status === FLOW_RESULT.SETTLED ? result.value : undefined;
    const exploration = answer?.exploration ?? failedExploration(question);
    if (result?.status === FLOW_RESULT.THREW) {
      console.error(`[qa] explore ${question.id} failed: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
      deps.record({ reason: `explore ${question.id}: the session failed`, delegationId: exploreDelegationId(input.runId, question.id), failureClass: "session-failed" });
    }
    const status = answer?.exploration ? exploration.status : "failed";
    outcome.push({ id: question.id, question: question.question, status, findings: verifyExplorationFindings(exploration.findings, ground(question.id)) });
  }
  return { ran: true, questions: outcome };
}

const LABEL: Record<(typeof FINDING_VERIFICATION)[keyof typeof FINDING_VERIFICATION], string> = {
  [FINDING_VERIFICATION.VERIFIED]: "verified by the orchestrator",
  [FINDING_VERIFICATION.UNVERIFIED]: "CLAIM, not verified",
  [FINDING_VERIFICATION.CONTRADICTED]: "CONTRADICTED by the orchestrator's own read",
};

/* The lead's next turn: the findings labelled by what the orchestrator checked, and the one answer that is left to give. */
export function renderExploreOutcome(redaction: RedactionPort, outcome: ExploreOutcome): string {
  const lines: string[] = ["## Exploration findings", "The orchestrator ran the exploration you asked for. Verified findings are facts; a claim that is not verified is only the explore sidekick's word; where a finding is contradicted, the orchestrator's read stands."];
  if (outcome.skipped) lines.push(`No exploration ran: ${redaction.redact(outcome.skipped)}. Plan from what you have.`);
  for (const question of outcome.questions) {
    lines.push("", `### ${question.id}: ${redaction.redact(question.question)}`, `status: ${question.status}`);
    if (question.findings.length === 0) lines.push("(no findings)");
    for (const finding of question.findings) {
      lines.push(`- [${LABEL[finding.verification]}] (${finding.kind}) ${redaction.redact(finding.claim)} | ref: ${redaction.redact(finding.ref)} | evidence: ${redaction.redact(finding.evidence)}${finding.contradictedBy ? ` | the orchestrator: ${redaction.redact(finding.contradictedBy)}` : ""}`);
    }
  }
  lines.push("", 'Now answer with your plan: ONLY the JSON object `{"plan":...}` (or the declared no-op). You cannot explore again.');
  return lines.join("\n");
}
