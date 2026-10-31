/* What every step of a run may use and never returns: the run's input, its dependencies and configuration, the trail of its phase cursor and live handles, and (once the working copy is prepared) the run's live services. Separate from the run's state, which holds only data. */

import type { PreconditionTerminal } from "../../domain/helpers/precondition-terminal.ts";
import type { CycleBudget } from "../../domain/cycle-budget.ts";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import type { PreconditionFailure, RunQaConfig, RunQaInput, RunQaUseCaseDeps, RunTrail } from "./run-types.ts";
import type { CoordinationGateSignal } from "@kernel/coordination.ts";
import type { ServedVersionSignal } from "@kernel/served-version.ts";
import type { LessonsSignal } from "@kernel/lessons-signal.ts";
import type { WorkspaceHandle } from "@contexts/workspace-and-publication/application/index.ts";
import type { RunServices } from "./run-services.ts";

/* What the use case does for a run that is not an end: the notes it keeps on the trail, the login and suite helpers, and the ambient sandbox facts. Bound to the run. */
export interface RunHost {
  /** What the lead/sidekick mode came to, read when the run's outcome is built. */
  recordCoordination(signal: CoordinationGateSignal): void;
  /** Records what the lead routed of the reviewer's corrections with the run's coordination. */
  recordCorrections(): void;
  /** Releases the coordinated pass kept open for the reviewer's corrections; nothing when none is open. */
  closeCoordinatedPass(): Promise<void>;
  noteGroundingGates(result: { preExecAmbiguityCatches: number; catalogGateInWindow: number; catalogGateAdvisory: number; catalogGateFailClosed: number }): void;
  pruneMirror(workspace: WorkspaceHandle): Promise<void>;
  noteDeadlineArmed(): void;
  /** The text with the secrets of this run replaced. */
  redact(text: string): string;
  /** Untrusted text redacted (the run's secrets by value, then the outbound patterns) and then cut to `maxChars`: the order in which a secret that straddles the cut is still found (shared-kernel/redact-then-bound.ts). */
  boundText(text: string, maxChars: number, marker?: (original: number, kept: number) => string): string;
  prepareAuth(specDir: string, phase: "pre-generate" | "pre-execute", signal?: AbortSignal): Promise<{ unauthored: boolean; setupSha256?: string } | { failed: string } | { precondition: PreconditionFailure }>;
  replaceRestoredLogin(workspace: WorkspaceHandle, signal?: AbortSignal): Promise<"replaced" | "unchanged" | "setup-failed">;
  announceSuite(text: string, level: "info" | "warn"): void;
  announcePrecondition(failure: PreconditionFailure, action: PreconditionTerminal["action"], phase: "pre-generate" | "pre-execute"): void;
  preconditionNote(failure: PreconditionFailure): string;
  /** What the lead/sidekick mode came to, as recorded for this run; absent when the run was not coordinated. */
  coordination(): CoordinationGateSignal | undefined;
  /** What DEV served relative to the commit under test, once the gate read it; absent when the run ended before the gate did. */
  servedVersion(): ServedVersionSignal | undefined;
  /** What the run recorded of the pages it read of DEV; absent when it read none or recorded none. */
  lessons(): LessonsSignal | undefined;
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
  host: RunHost;
}

export interface WorkspaceRunContext extends RunContext {
  workspace: WorkspaceHandle;
  services: RunServices;
}
