/* What every step of a run may use and never returns: the run's input, its dependencies and configuration, the trail of its phase cursor and live handles, and (once the working copy is prepared) the run's live services. Separate from the run's state, which holds only data. */

import type { CycleBudget } from "../../domain/cycle-budget.ts";
import type { WallClockBudget } from "../../domain/wall-clock-budget.ts";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import type { PreconditionFailure, RunQaConfig, RunQaInput, RunQaUseCaseDeps, RunTrail } from "./run-types.ts";
import type { CoordinationGateSignal } from "@kernel/coordination.ts";
import type { PreparedWorkspace, RunServices } from "./run-services.ts";

/* What the use case does for a run that is not an end: the notes it keeps on the trail, the login and suite helpers, and the ambient sandbox facts. Bound to the run. */
export interface RunHost {
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
  /** What the lead/sidekick mode came to, as recorded for this run; absent when the run was not coordinated. */
  coordination(): CoordinationGateSignal | undefined;
  /** Whether the launcher refused to start agent code in this run. */
  sandboxRefused(): boolean;
  /** What the run's sandbox did, for the persisted gate signals; absent when no child was started. */
  sandboxSignal(): { egress: "enforced" | "unenforced" | "not-applicable"; denied: string[] } | undefined;
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
  host: RunHost;
}

export interface WorkspaceRunContext extends RunContext {
  workspace: PreparedWorkspace;
  services: RunServices;
}
