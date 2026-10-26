/*
 * Why a run ended, and what the end carries. Every end names one reason from a closed set and carries exactly the facts that
 * reason has: a reason cannot carry a fact it never had. The end is data; `finalizeRun` is the one place that turns it into the
 * run's result and does what the reason calls for to the working copy, the run history, publication and learning (END_EFFECTS).
 */

import type { ClosedLoopGateSignal } from "@kernel/closed-loop.ts";
import type { AgentBrowserGateSignal } from "@kernel/agent-browser.ts";
import type { GenerationEndKind } from "@kernel/generation-end.ts";
import type { NoopKind } from "@kernel/noop-kind.ts";
import type { DisputedFinding } from "../../domain/review-rebuttals.service.ts";
import { END_REASONS, type EndReason } from "./end-reason.ts";

export { END_REASONS, type EndReason };
import type { ConfinementTotals } from "./run-services.ts";

/** The counters of the pre-execution gate as a persisted outcome carries them; 0, never absent, once the gate is in the type. */
export interface GroundingSignals {
  preExecAmbiguityCatches: number;
  deterministicSelectorBlocks: number;
  catalogGateInWindow: number;
  catalogGateAdvisory: number;
  catalogGateFailClosed: number;
}

/** What a persisted end knows about the run so far; each fact is absent unless the end genuinely has it, never fabricated. */
export interface EndEvidence {
  /** Present only when a reviewer ran. */
  reviewerApproved?: boolean | undefined;
  /** Static-fix retries consumed before the end. */
  retries?: number;
  groundingSignals?: GroundingSignals;
  rulesRetrieved?: string[];
  /** The diff's structural shapes the fold attributes the retrieved rules against; absent when there is no diff. */
  diffArchetypes?: string[] | undefined;
  /** Diff-derived archetype; null when there is no diff. */
  archetype?: string | null;
  /** Merged confinement from the last enforcement before the end; absent if it never ran. */
  confinement?: ConfinementTotals | undefined;
  /** The latest generation's tested section; absent when there are no specMetas. */
  tested?: { flow?: string; objective?: string }[] | undefined;
  /** How the run_spec loop was used up to the end; absent when the run did not grant it. */
  closedLoop?: ClosedLoopGateSignal | undefined;
  /** How the authenticated agent browser was used up to the end; absent when the run did not grant it. */
  agentBrowser?: AgentBrowserGateSignal | undefined;
}

/** The ends that leave nothing behind but an infra-error result with a note: no run record, no publication, no learning. */
export type NotedFailure = "deploy-gate-failed" | "setup-failed" | "auth-failed" | "generation-empty-output" | "final-proof-guard" | "publication-failed";

/** An infra-error that stopped the run before it could reach a verdict, persisted on its own. */
export type UnreachedVerdict = "sandbox-unavailable" | "probe-sweep-failed";

export type RunEnd =
  | { reason: "aborted" }
  | { reason: "classify-skipped" }
  | { reason: NotedFailure; note: string }
  /** A declared no-op: a skip the run records. */
  | { reason: "generation-noop"; note: string | undefined; reviewerApproved: boolean | undefined; noop?: { kind: NoopKind }; confinement?: ConfinementTotals; closedLoop?: ClosedLoopGateSignal; agentBrowser?: AgentBrowserGateSignal }
  /** The app's login could not be completed, on a positive piece of evidence. */
  | { reason: "login-precondition"; generating: boolean; note: string }
  /** The generation delivered no specs and decided nothing; `generationEnd` names how it ended. */
  | ({ reason: "generation-ended-without-specs"; generationEnd: GenerationEndKind; note: string } & EndEvidence)
  /** The static gate refused the specs. */
  | ({ reason: "static-gate-failed"; generating: boolean; note: string | undefined } & EndEvidence)
  /** The run could not execute the specs it validated: the static gate itself could not run, DEV is down, or the login before execute failed. */
  | ({ reason: "pre-execute-infra"; generating: boolean; note: string | undefined; preconditionFailed?: boolean } & EndEvidence)
  /** A green run whose reviewer could not be reached: its tests were never judged. */
  | ({ reason: "reviewer-unavailable"; rationale: string | undefined; passedCases: number; static: boolean } & EndEvidence)
  /** A green run whose reviewer and generator could not settle a verified finding. */
  | ({ reason: "review-disputed"; disputed: readonly DisputedFinding[]; passedCases: number; static: boolean } & EndEvidence)
  /** The run's time was spent. */
  | { reason: "run-deadline"; note: string; generationEnd: GenerationEndKind; rulesRetrieved?: string[] }
  | { reason: UnreachedVerdict; note: string; rulesRetrieved?: string[] }
  /** The run reached its decision (`state.decided`); `finalizeRun` carries it out. */
  | { reason: "decided" }
  | { reason: "context-pass" };

/* One member per reason: a member that names several reasons is split, so a reason picks out exactly its own facts. */
type PerReason<E> = E extends { reason: infer R } ? (R extends EndReason ? Omit<E, "reason"> & { reason: R } : never) : never;
type EndOf<R extends EndReason> = Extract<PerReason<RunEnd>, { reason: R }>;
type FactsOf<R extends EndReason> = Omit<EndOf<R>, "reason">;

/** The facts argument of an end: absent exactly when the reason has none. */
export type FactsArg<R extends EndReason> = Record<string, never> extends FactsOf<R> ? [facts?: FactsOf<R>] : [facts: FactsOf<R>];

/** Builds an end of the given reason; the facts the reason carries are required, the ones it never has do not type-check. */
export function runEnd<R extends EndReason>(reason: R, ...facts: FactsArg<R>): EndOf<R> {
  return { reason, ...(facts[0] ?? {}) } as unknown as EndOf<R>;
}

/*
 * What an end does to the outside, by reason. `persist`: the run history gets a record ("not-in-context-mode": a context run keeps
 * its Issue and no record). `publish`: "decision" dispatches whatever side effect the end's decision calls for (an Issue, a pull
 * request, the quarantine and shadow log lines); "none" never publishes. `learn`: "mainline" is the learning of a run that executed
 * its suite, "terminal" the stricter learning of a run that ended earlier; both are further gated by what the outcome's class
 * teaches (learningGates), never by the end alone. `prune`: the working copy is pruned once the git write is done, before the run's record is saved, except for a declared no-op, which records its skip first. The table is
 * pinned row by row against the run-end table of the tests.
 */
export interface EndEffects {
  persist: "yes" | "no" | "not-in-context-mode";
  publish: "decision" | "none";
  learn: "mainline" | "terminal" | "none";
  prune: "before-persist" | "after-persist";
  /** The write-confinement pass runs one last time before the end is carried out, and its totals are the ones the record carries. */
  enforce: boolean;
}

const UNRECORDED: EndEffects = { persist: "no", publish: "none", learn: "none", prune: "before-persist", enforce: false };
const RECORDED_TERMINAL: EndEffects = { persist: "yes", publish: "decision", learn: "terminal", prune: "before-persist", enforce: false };

/* What a run that dies on an error nothing handles keeps when a child of its sandbox left evidence: the record of a terminal, learned from like one. */
export const CRASH_EVIDENCE_EFFECTS: EndEffects = RECORDED_TERMINAL;

export const END_EFFECTS: Readonly<Record<EndReason, EndEffects>> = {
  aborted: UNRECORDED,
  "deploy-gate-failed": UNRECORDED,
  "classify-skipped": UNRECORDED,
  "setup-failed": UNRECORDED,
  "auth-failed": UNRECORDED,
  "login-precondition": RECORDED_TERMINAL,
  "generation-noop": { persist: "yes", publish: "none", learn: "none", prune: "after-persist", enforce: false },
  "generation-ended-without-specs": RECORDED_TERMINAL,
  "generation-empty-output": UNRECORDED,
  /* The last confinement pass comes immediately before this exit's publish(). */
  "static-gate-failed": { ...RECORDED_TERMINAL, persist: "not-in-context-mode", enforce: true },
  /* The specs were generated, so their strays are reverted even though this exit does not publish. */
  "pre-execute-infra": { ...RECORDED_TERMINAL, enforce: true },
  "reviewer-unavailable": RECORDED_TERMINAL,
  "review-disputed": RECORDED_TERMINAL,
  "final-proof-guard": UNRECORDED,
  "publication-failed": UNRECORDED,
  "run-deadline": RECORDED_TERMINAL,
  "sandbox-unavailable": RECORDED_TERMINAL,
  "probe-sweep-failed": RECORDED_TERMINAL,
  decided: { persist: "yes", publish: "decision", learn: "mainline", prune: "before-persist", enforce: true },
  "context-pass": { persist: "no", publish: "decision", learn: "none", prune: "before-persist", enforce: true },
};
