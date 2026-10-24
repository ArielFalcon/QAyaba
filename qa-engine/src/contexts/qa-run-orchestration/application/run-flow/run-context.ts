/* What every step of a run may use and never returns: the run's input, its dependencies and configuration, the trail its phases leave, and (once the working copy is prepared) the run's live services. Separate from the run's state, which holds only data. */

import type { CycleBudget } from "../../domain/cycle-budget.ts";
import type { WallClockBudget } from "../../domain/wall-clock-budget.ts";
import type { DisputedFinding } from "../../domain/review-rebuttals.service.ts";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import type { OutcomeExtras, PreconditionFailure, RunQaConfig, RunQaInput, RunQaResult, RunQaUseCaseDeps, RunTrail, TerminalOptions } from "../run-qa.use-case.ts";
import type { ClosedLoopGateSignal } from "@kernel/closed-loop.ts";
import type { AgentBrowserGateSignal } from "@kernel/agent-browser.ts";
import type { CoordinationGateSignal } from "@kernel/coordination.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { GenerationEndKind } from "@kernel/generation-end.ts";
import type { ReflectionInput } from "@contexts/cross-run-learning/application/ports/index.ts";
import type { RunDecision } from "../../domain/run-decision.ts";
import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
import type { NoopKind } from "@kernel/noop-kind.ts";
import type { PreparedWorkspace, RunServices, ConfinementTotals } from "./run-services.ts";

/* The use case's own ways to end a run and the trail notes it keeps, bound to the run. */
export interface RunEnds {
  aborted(mirrorDir?: string): Promise<RunQaResult>;
  infraError(note?: string, mirrorDir?: string): Promise<RunQaResult>;
  skipped(opts?: { note?: string | undefined; reviewerApproved?: boolean | undefined }): RunQaResult;
  /** Saves the outcome of a declared no-op skip, prunes the mirror and returns the skip with that outcome. */
  persistSkipped(skipped: RunQaResult, extra: { noop?: { kind: NoopKind }; confinement?: ConfinementTotals; closedLoop?: ClosedLoopGateSignal; agentBrowser?: AgentBrowserGateSignal }): Promise<RunQaResult>;
  /** What the lead/sidekick mode came to, read when the run's outcome is built. */
  recordCoordination(signal: CoordinationGateSignal): void;
  /** Records what the lead routed of the reviewer's corrections with the run's coordination. */
  recordCorrections(): void;
  /** Releases the coordinated pass kept open for the reviewer's corrections; nothing when none is open. */
  closeCoordinatedPass(): Promise<void>;
  noteGroundingGates(result: { preExecAmbiguityCatches: number; catalogGateInWindow: number; catalogGateAdvisory: number; catalogGateFailClosed: number }): void;
  pruneMirror(mirrorDir: string): Promise<void>;
  noteDeadlineArmed(): void;
  prepareAuth(specDir: string, phase: "pre-generate" | "pre-execute", signal?: AbortSignal): Promise<{ unauthored: boolean; setupSha256?: string } | { failed: string } | { precondition: PreconditionFailure }>;
  replaceRestoredLogin(workspace: { specDir: string; mirrorDir: string }, signal?: AbortSignal): Promise<"replaced" | "unchanged" | "setup-failed">;
  announceSuite(text: string, level: "info" | "warn"): void;
  announcePrecondition(failure: PreconditionFailure, ends: boolean): void;
  preconditionNote(failure: PreconditionFailure): string;
  /** Ends the run with a persisted invalid or infra-error verdict. */
  terminal(verdict: "invalid" | "infra-error", ev: { generating: boolean; static: boolean }, opts?: TerminalOptions): Promise<RunQaResult>;
  /** What the lead/sidekick mode came to, as recorded for this run; absent when the run was not coordinated. */
  coordination(): CoordinationGateSignal | undefined;
  /** The error class a verdict resolves to, with the run's own ways to end. */
  deriveErrorClass(
    verdict: string,
    coverageRatio: number | null,
    valueScore: number | null,
    reviewerCorrections?: string[],
    ends?: { generationEnd?: GenerationEndKind | undefined; preconditionFailed?: boolean | undefined; reviewerUnavailable?: boolean | undefined; reviewDisputed?: boolean | undefined },
  ): string | null;
  /** The outcome the run persists for a decision, bound to this run's input. */
  toRunOutcome(decision: RunDecision, cases: QaCase[], retries: number, coverageRatio: number | null, errorClass: string | null, extra?: OutcomeExtras): RunOutcome;
  /** The narrow view of a persisted outcome the reflector learns from. */
  toReflectionInput(outcome: RunOutcome, archetype: string | null): ReflectionInput;
  /** Ends a green run whose reviewer could not be reached: a persisted infra-error with the reviewer's reason on the record, nothing learned. */
  reviewerUnavailable(reason: string | undefined, passedCases: number, exit: Omit<TerminalOptions, "note" | "reviewerUnavailable" | "reviewerRationale"> & { static: boolean }): Promise<RunQaResult>;
  /** Ends a green run whose reviewer and generator could not settle a verified finding: a persisted infra-error, nothing learned. */
  reviewDisputed(disputed: readonly DisputedFinding[], passedCases: number, exit: Omit<TerminalOptions, "note" | "reviewDisputed"> & { static: boolean }): Promise<RunQaResult>;
}

export interface RunContext {
  input: RunQaInput;
  signal: AbortSignal | undefined;
  trail: RunTrail;
  deps: RunQaUseCaseDeps;
  /** The deps' telemetry behind the guard that keeps a recording fault from failing the run. */
  telemetry: TelemetryPort;
  cfg: RunQaConfig;
  startedAt: number;
  cycleBudget: CycleBudget;
  wallClockBudget: WallClockBudget;
  ends: RunEnds;
}

/* The specs this run has delivered so far, merged after every generation pass: a lead pass refreshes what its verdict declared for each spec, a sidekick pass adds paths only. Every regeneration is handed them. The one mutable fact of the generation, so the context owns it. */
export interface GenerationLedger {
  delivered: readonly DeliveredSpec[];
}

export interface WorkspaceRunContext extends RunContext {
  workspace: PreparedWorkspace;
  services: RunServices;
  generation: GenerationLedger;
}
