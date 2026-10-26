/*
 * How a run ends. `finalizeRun` turns an end (a reason and the facts it carries) into the run's result and does what the reason
 * calls for to the outside, in one fixed order: publish what the decision calls for, prune the working copy once the git write is
 * done, save the run's record, learn from it, say the run is done. Which of these a reason does is END_EFFECTS (run-end.ts); the
 * body here is the same for every end, so a change to what an end does is made once. It is the only place the run is saved,
 * published, learned from and pruned: the end a decided run reaches (publication and its failure included) is built by
 * decided-end.ts and goes through the same body, and a crash goes through it with the evidence the run has (CRASH_EVIDENCE_EFFECTS).
 */

import type { GenerationEndKind } from "@kernel/generation-end.ts";
import type { NoopKind } from "@kernel/noop-kind.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { decide } from "../../domain/run-decision.service.ts";
import { RunDecision } from "../../domain/run-decision.ts";
import { ERROR_CLASS } from "@contexts/cross-run-learning/application/index.ts";
import { learningGates, observesOperatingSignal } from "@contexts/cross-run-learning/application/index.ts";
import type { PublicationPort } from "../ports/publication.port.ts";
import type { RunQaResult } from "./run-types.ts";
import type { RunContext, WorkspaceRunContext } from "./run-context.ts";
import { deriveErrorClass, toReflectionInput, toRunOutcome } from "./outcome-assembly.ts";
import { CRASH_EVIDENCE_EFFECTS, END_EFFECTS, type EndEffects, type EndEvidence, type GroundingSignals, type RunEnd } from "./run-end.ts";
import type { WorkspaceHandle } from "../../domain/workspace-handle.ts";
import type { RunState } from "./run-state.ts";
import { finalizeDecided } from "./decided-end.ts";

const NO_GROUNDING_SIGNALS: GroundingSignals = { preExecAmbiguityCatches: 0, deterministicSelectorBlocks: 0, catalogGateInWindow: 0, catalogGateAdvisory: 0, catalogGateFailClosed: 0 };

/* Everything a persisted terminal end is built from: the verdict it ends with and what the run knew of itself when it did. */
interface TerminalShape extends EndEvidence {
  verdict: "invalid" | "infra-error";
  generating: boolean;
  static: boolean;
  note?: string | undefined;
  /** The generation end that closed the run, when one did: it names the run's error class. */
  generationEnd?: GenerationEndKind | undefined;
  /** The run ended on a positively evidenced login failure: it names the run's error class. */
  preconditionFailed?: boolean | undefined;
  reviewerUnavailable?: boolean | undefined;
  reviewDisputed?: boolean | undefined;
  /** What the reviewer's runtime reported when it was unavailable, persisted on the run record. */
  reviewerRationale?: string | undefined;
}

/* What an end is, once it is told apart by the shape of the result it returns. */
type Shape =
  | { kind: "failure"; note: string | undefined }
  | { kind: "skip"; note: string | undefined; reviewerApproved: boolean | undefined; noop?: { kind: NoopKind } | undefined; confinement?: EndEvidence["confinement"]; closedLoop?: EndEvidence["closedLoop"]; agentBrowser?: EndEvidence["agentBrowser"] }
  | { kind: "terminal"; terminal: TerminalShape };

/* The working copy exists once the run prepared it, whether or not the services over it were built. */
const hasWorkspace = (ctx: RunContext): ctx is RunContext & { workspace: WorkspaceHandle } => "workspace" in ctx;
const isWorkspaceContext = (ctx: RunContext): ctx is WorkspaceRunContext => "workspace" in ctx && "services" in ctx;

export async function finalizeRun(end: RunEnd, ctx: RunContext, state: Readonly<RunState>): Promise<RunQaResult> {
  const effects = END_EFFECTS[end.reason];
  if (end.reason === "decided" || end.reason === "context-pass") {
    if (!isWorkspaceContext(ctx)) throw new Error("a run cannot be decided before its working copy is prepared");
    return await finalizeDecided(state, ctx);
  }
  return await finalizeShape(shapeOf(await enforcedEnd(end, effects, ctx), ctx), effects, ctx, state);
}

/* The last confinement pass an end asks for, and the totals of every pass the run made as the evidence the end carries. */
async function enforcedEnd<E extends Exclude<RunEnd, { reason: "decided" | "context-pass" }>>(end: E, effects: EndEffects, ctx: RunContext): Promise<E> {
  if (!effects.enforce || !isWorkspaceContext(ctx)) return end;
  await ctx.services.confinement.enforce();
  const { totals } = ctx.services.confinement;
  return totals === undefined ? end : { ...end, confinement: totals };
}

/*
 * A run that ends on an error nothing handles leaves its record to the caller, which cannot read the run's sandbox scope. When a
 * child ran, the evidence the scope holds is kept as a persisted infra-error before the error goes on; the caller rethrows.
 */
export async function recordCrashEvidence(note: string, ctx: RunContext, state: Readonly<RunState>): Promise<void> {
  const { rulesRetrieved } = state.run;
  await finalizeShape({ kind: "terminal", terminal: { verdict: "infra-error", generating: true, static: false, note, ...(rulesRetrieved ? { rulesRetrieved } : {}) } }, CRASH_EVIDENCE_EFFECTS, ctx, state);
}

async function finalizeShape(shape: Shape, effects: EndEffects, ctx: RunContext, state: Readonly<RunState>): Promise<RunQaResult> {
  const { deps, input } = ctx;
  const decision = decisionOf(shape, ctx);
  let publishOutcome: string | undefined;
  if (effects.publish === "decision" && decision.sideEffect !== "none") {
    publishOutcome = await publishTerminal(shape, ctx);
  }
  const prune = async (): Promise<void> => {
    if (hasWorkspace(ctx)) await ctx.host.pruneMirror(ctx.workspace);
  };
  if (effects.prune === "before-persist") await prune();

  const note = noteOf(shape, publishOutcome);
  const persists = effects.persist === "yes" || (effects.persist === "not-in-context-mode" && input.mode !== "context");
  const outcome = persists ? outcomeOf(shape, decision, note, ctx) : undefined;
  if (outcome) {
    await deps.runHistory.save(outcome);
  }
  if (effects.prune === "after-persist") await prune();
  if (outcome && effects.learn === "terminal" && shape.kind === "terminal") await learnFromTerminal(outcome, shape.terminal, ctx);
  deps.observer?.onStep("done");
  return resultOf(shape, decision, outcome, note, persists, ctx);
}

/* Said aloud before anything else happens, so a run's end is never silent, and shaped into the form its result takes. */
function shapeOf(end: Exclude<RunEnd, { reason: "decided" | "context-pass" }>, ctx: RunContext): Shape {
  const { deps } = ctx;
  switch (end.reason) {
    case "aborted":
      /* A cancelled run is not a learner failure: the runner writes "cancelled by operator" on the record, so no note here. */
      return { kind: "failure", note: undefined };
    case "classify-skipped":
      return { kind: "skip", note: undefined, reviewerApproved: undefined };
    case "deploy-gate-failed":
    case "setup-failed":
    case "auth-failed":
    case "generation-empty-output":
    case "final-proof-guard":
      console.error("[qa] infra-error terminal:", end.note);
      return { kind: "failure", note: end.note };
    case "generation-noop":
      return { kind: "skip", note: end.note, reviewerApproved: end.reviewerApproved, noop: end.noop, confinement: end.confinement, closedLoop: end.closedLoop, agentBrowser: end.agentBrowser };
    case "login-precondition":
      return { kind: "terminal", terminal: { verdict: "infra-error", generating: end.generating, static: false, preconditionFailed: true, note: end.note } };
    case "generation-ended-without-specs": {
      const { reason: _reason, ...facts } = end;
      return { kind: "terminal", terminal: { verdict: "infra-error", generating: true, static: false, ...facts } };
    }
    case "static-gate-failed": {
      const { reason: _reason, ...facts } = end;
      return { kind: "terminal", terminal: { verdict: "invalid", ...facts, static: false } };
    }
    case "pre-execute-infra": {
      const { reason: _reason, ...facts } = end;
      return { kind: "terminal", terminal: { verdict: "infra-error", ...facts, static: false } };
    }
    case "reviewer-unavailable": {
      const note = `The reviewer was unavailable (${end.rationale ?? "no reason reported"}), so the suite (${end.passedCases} case(s), green) was never judged. Nothing was published: no PR, and no Issue, since this is not a rejection.`;
      console.error(`[qa] ${note}`);
      deps.observer?.onEvent({ type: "agent.error", detail: note });
      deps.observer?.onEvent({
        type: "log.line",
        level: "error",
        text: `[qa] the run ended with its reviewer unavailable (${ERROR_CLASS.REVIEWER_UNAVAILABLE}): an integration fault, not a rejection of the tests`,
      });
      const { reason: _reason, rationale, passedCases: _passedCases, static: staticOk, ...evidence } = end;
      return { kind: "terminal", terminal: { verdict: "infra-error", generating: true, static: staticOk, ...evidence, note, reviewerUnavailable: true, ...(rationale !== undefined ? { reviewerRationale: rationale } : {}) } };
    }
    case "review-disputed": {
      const findings = end.disputed.map((entry) => `"${entry.finding}" (rebutted: ${entry.rebuttal.reason})`).join("; ");
      const note = `The reviewer and the generator could not settle ${end.disputed.length} finding(s), so the suite (${end.passedCases} case(s), green) was never approved: ${findings}. The rebuttal rests on evidence the orchestrator could not verify, and the generator delivered nothing else. Nothing was published: no PR, and no Issue, since the engine could not decide.`;
      console.error(`[qa] ${note}`);
      deps.observer?.onEvent({ type: "agent.error", detail: note });
      deps.observer?.onEvent({
        type: "log.line",
        level: "error",
        text: `[qa] the run ended on an unresolved review dispute (${ERROR_CLASS.REVIEW_DISPUTED}): the finding stands, the rebuttal is unverified, and neither a PR nor an Issue would be honest`,
      });
      const { reason: _reason, disputed: _disputed, passedCases: _passedCases, static: staticOk, ...evidence } = end;
      return { kind: "terminal", terminal: { verdict: "infra-error", generating: true, static: staticOk, ...evidence, note, reviewDisputed: true } };
    }
    case "run-deadline":
      return { kind: "terminal", terminal: { verdict: "infra-error", generating: true, static: false, note: end.note, generationEnd: end.generationEnd, ...(end.rulesRetrieved ? { rulesRetrieved: end.rulesRetrieved } : {}) } };
    case "sandbox-unavailable":
    case "probe-sweep-failed":
      return { kind: "terminal", terminal: { verdict: "infra-error", generating: true, static: false, note: end.note, ...(end.rulesRetrieved ? { rulesRetrieved: end.rulesRetrieved } : {}) } };
  }
}

function decisionOf(shape: Shape, ctx: RunContext): RunDecision {
  switch (shape.kind) {
    case "failure":
      return RunDecision.of("infra-error", "none");
    case "skip":
      return RunDecision.of("skipped", "none");
    case "terminal":
      return decide({
        verdict: shape.terminal.verdict,
        generating: shape.terminal.generating,
        needsReview: ctx.cfg.needsReview,
        reviewerApproved: true,
        blocksPublish: false,
        shadow: ctx.cfg.shadow,
        onFailure: ctx.cfg.onFailure,
      });
  }
}

/* The same publish() as the decided end: an invalid terminal opens an Issue, an infra-error resolves to side effect "none" and never gets here. */
async function publishTerminal(shape: Shape, ctx: RunContext): Promise<string | undefined> {
  if (shape.kind !== "terminal") return undefined;
  const { terminal } = shape;
  const published = await ctx.deps.publication.publish({
    verdict: terminal.verdict,
    cases: [],
    logs: terminal.note ?? "",
    reviewerApproved: terminal.reviewerApproved,
    coverageBlocks: false,
    ...(ctx.input.triggerRepo ? { issueRepo: ctx.input.triggerRepo } : {}),
    /* tested still renders into the Issue body when present. A terminal never routes to "pr". */
    ...(terminal.tested?.length ? { tested: terminal.tested } : {}),
  } satisfies Parameters<PublicationPort["publish"]>[0]);
  return published.outcome;
}

/* Appends the publish outcome onto the note; an existing diagnostic is never clobbered. */
function noteOf(shape: Shape, publishOutcome: string | undefined): string | undefined {
  const own = shape.kind === "terminal" ? shape.terminal.note : shape.note;
  return [own, publishOutcome].filter((part): part is string => Boolean(part)).join("\n\n") || undefined;
}

function outcomeOf(shape: Shape, decision: RunDecision, note: string | undefined, ctx: RunContext): RunOutcome | undefined {
  if (shape.kind === "skip") {
    return toRunOutcome(ctx, decision, [], 0, null, deriveErrorClass("skipped", null, null), {
      reviewerApproved: shape.reviewerApproved,
      ...(shape.noop ? { noop: shape.noop } : {}),
      ...(shape.note !== undefined ? { note: shape.note } : {}),
      ...(shape.confinement !== undefined ? { confinement: shape.confinement } : {}),
      ...(shape.closedLoop ? { closedLoop: shape.closedLoop } : {}),
      ...(shape.agentBrowser ? { agentBrowser: shape.agentBrowser } : {}),
    });
  }
  if (shape.kind === "failure") return undefined;
  const { terminal } = shape;
  const rulesRetrieved = terminal.rulesRetrieved ?? [];
  return toRunOutcome(ctx, decision, [], terminal.retries ?? 0, null, errorClassOf(terminal, ctx), {
    staticOk: terminal.static,
    reviewerApproved: terminal.reviewerApproved,
    note,
    ...(terminal.reviewerRationale !== undefined ? { reviewerRationale: terminal.reviewerRationale } : {}),
    ...(terminal.groundingSignals ?? NO_GROUNDING_SIGNALS),
    /* Empty retrieved ids omit the override; non-empty reach persist so the terminal fold can attribute. */
    ...(rulesRetrieved.length ? { rulesRetrieved } : {}),
    ...(terminal.diffArchetypes ? { diffArchetypes: terminal.diffArchetypes } : {}),
    ...(terminal.confinement !== undefined ? { confinement: terminal.confinement } : {}),
    ...(terminal.closedLoop ? { closedLoop: terminal.closedLoop } : {}),
    ...(terminal.agentBrowser ? { agentBrowser: terminal.agentBrowser } : {}),
  });
}

/* invalid → E-STATIC, infra-error → E-INFRA, unless a generation end or a failed precondition that ended the run names its own class. */
function errorClassOf(terminal: TerminalShape, ctx: RunContext): string | null {
  const { generationEnd, preconditionFailed, reviewerUnavailable, reviewDisputed } = terminal;
  return deriveErrorClass(terminal.verdict, null, null, [], { generationEnd, preconditionFailed, reviewerUnavailable, reviewDisputed, sandboxRefused: ctx.host.sandboxRefused() });
}

/* The same learning gates as the decided end, at the terminal stage: a terminal outcome teaches only through a class that teaches. */
async function learnFromTerminal(outcome: RunOutcome, terminal: TerminalShape, ctx: RunContext): Promise<void> {
  const { deps, input, cfg } = ctx;
  const learning = learningGates({
    stage: "terminal",
    mode: input.mode,
    verdict: terminal.verdict,
    errorClass: outcome.errorClass,
    isCode: cfg.isCode,
    adjudicationClass: outcome.adjudication?.class,
  });
  if (learning.fold) await deps.learning.fold(outcome);
  if (deps.reflector && learning.reflect) {
    const startedAt = Date.now();
    await deps.reflector.reflect(toReflectionInput(outcome, terminal.archetype ?? null));
    deps.observer?.onEvent({ type: "log.line", level: "info", text: `[qa] reflect() for run ${outcome.runId} took ${Date.now() - startedAt}ms` });
  }
  /* The audit is independently optional, and also sees the operating signal of a class that teaches nothing. */
  if (deps.processAudit && (learning.reflect || observesOperatingSignal({ mode: input.mode, errorClass: outcome.errorClass }))) {
    const startedAt = Date.now();
    await deps.processAudit.audit(outcome);
    deps.observer?.onEvent({ type: "log.line", level: "info", text: `[qa] processAudit.audit() for run ${outcome.runId} took ${Date.now() - startedAt}ms` });
  }
}

function resultOf(shape: Shape, decision: RunDecision, outcome: RunOutcome | undefined, note: string | undefined, persisted: boolean, ctx: RunContext): RunQaResult {
  const { host } = ctx;
  if (shape.kind === "failure") {
    return {
      decision,
      /* An end that persists nothing still derives its class for the returned result. */
      errorClass: deriveErrorClass("infra-error", null, null, [], { sandboxRefused: ctx.host.sandboxRefused() }),
      gateSignals: { static: false, coverageRatio: null, valueScore: null, retries: 0, ...NO_GROUNDING_SIGNALS },
      cases: [],
      rulesRetrieved: [],
      ...(shape.note !== undefined ? { note: shape.note } : {}),
    };
  }
  if (shape.kind === "skip") {
    const result: RunQaResult = {
      decision,
      ...(shape.note ? { note: shape.note } : {}),
      /* A skipped run always resolves errorClass null: skipped runs teach nothing. */
      errorClass: deriveErrorClass("skipped", null, null),
      gateSignals: {
        static: false,
        coverageRatio: null,
        valueScore: null,
        ...(shape.reviewerApproved !== undefined ? { reviewerApproved: shape.reviewerApproved } : {}),
        retries: 0,
        ...NO_GROUNDING_SIGNALS,
      },
      cases: [],
      /* Neither skip source persists retrieved rule ids. */
      rulesRetrieved: [],
    };
    return outcome ? { ...result, outcome } : result;
  }
  const { terminal } = shape;
  const grounding = terminal.groundingSignals ?? NO_GROUNDING_SIGNALS;
  const coordination = host.coordination();
  return {
    decision,
    ...(outcome ? { outcome } : {}),
    /* A terminal that persisted nothing reports no class, no static pass and no retrieved rules: nothing was genuinely recorded. */
    errorClass: persisted ? errorClassOf(terminal, ctx) : null,
    gateSignals: {
      static: persisted ? terminal.static : false,
      coverageRatio: null,
      valueScore: null,
      ...(persisted && terminal.reviewerApproved !== undefined ? { reviewerApproved: terminal.reviewerApproved } : {}),
      retries: persisted ? (terminal.retries ?? 0) : 0,
      preExecAmbiguityCatches: persisted ? grounding.preExecAmbiguityCatches : 0,
      deterministicSelectorBlocks: persisted ? grounding.deterministicSelectorBlocks : 0,
      catalogGateInWindow: persisted ? grounding.catalogGateInWindow : 0,
      catalogGateAdvisory: persisted ? grounding.catalogGateAdvisory : 0,
      catalogGateFailClosed: persisted ? grounding.catalogGateFailClosed : 0,
      ...(persisted && terminal.closedLoop ? { closedLoop: terminal.closedLoop } : {}),
      ...(persisted && terminal.agentBrowser ? { agentBrowser: terminal.agentBrowser } : {}),
      ...(persisted && coordination ? { coordination } : {}),
    },
    cases: [],
    rulesRetrieved: persisted ? (terminal.rulesRetrieved ?? []) : [],
    ...(persisted && note !== undefined ? { note } : {}),
  };
}
