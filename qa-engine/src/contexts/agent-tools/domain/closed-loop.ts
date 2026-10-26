import type { RunMode, RunPurpose } from "@kernel/run-mode.ts";
import type { ClosedLoopLimits } from "@kernel/closed-loop.ts";

/**
 * The run_spec loop of one run, as the use case sees it: the right to execute a spec while authoring, granted to the
 * generator's own sessions. The run opens it after the login and closes it when it ends, however it ends.
 */
export interface ClosedLoopOpenInput {
  runId: string;
  app: string;
  mode: RunMode;
  purpose?: RunPurpose;
  mirrorDir: string;
  specDir: string;
  /** The run's own choice, when it makes one (an A/B arm): overrides the app's setting. Absent: the app's setting decides. */
  enabled?: boolean;
  /** The run's cancellation: a call in flight when it fires is stopped. */
  signal?: AbortSignal;
}

export interface ClosedLoopSignals {
  /** run_spec calls that started. */
  calls: number;
  /** Mutating requests the executed specs sent to DEV. */
  devWrites: number;
}

/** What a flow's loop is opened with: its own share of the run's calls and writes, the sidekick's workspace its spec is read from, and the one spec it may run. */
export interface FlowLoopOpenInput {
  delegationId: string;
  /** The flow's slug: it names the namespace of the flow's calls. */
  flowId: string;
  limits: { maxCalls: number; maxDevWrites: number };
  /** The sidekick's workspace: where its spec is written and read. */
  workspace: { dir: string; specDir: string };
  /** The one spec the flow may run, relative to the spec directory. */
  specFile: string;
  /** Puts the spec in the working copy where the suite runs it, and says where (relative to the spec directory), or undefined when the workspace has no such spec. Called inside the lease of each call. */
  stage(): Promise<string | undefined>;
}

/** One call of a flow's loop that ran: the bytes of the spec it ran (their sha256), and how it ended. */
export interface FlowLedgerEntry {
  path: string;
  sha256: string;
  status: string;
  devWrites: number;
  /** The facts of the call's failing tests: error, page by pathname, results read, server status, runtime errors, whether the page was still changing. */
  failures?: readonly FlowFailureFact[];
}

/** One failing test of a flow's run_spec call, as the orchestrator kept it. */
export interface FlowFailureFact {
  detail?: string;
  path?: string;
  resultCount?: number;
  httpStatus?: number;
  runtimeErrors?: readonly { type: string; text: string }[];
  unsettled?: true;
}

export interface FlowLoopHandle {
  /** What the flow's prompt states about the tool: its own share. */
  limits: ClosedLoopLimits;
  signals(): ClosedLoopSignals;
  /** What the orchestrator saw the flow's calls do, oldest first. */
  ledger(): readonly FlowLedgerEntry[];
  /** Whether the spec the sidekick holds now is the one whose last call passed. */
  isClosed(): Promise<boolean>;
  /** Revokes the flow's right and cleans the data of a call that was in flight. Never throws. */
  close(): Promise<void>;
}

export interface ClosedLoopHandle {
  /** What the generator's prompt states about the tool. */
  limits: ClosedLoopLimits;
  /** Opens the loop of one flow of a plan, for the sidekick that authors it; undefined once the run's loop is closed. Throws when the flow is already open. */
  openFlow(input: FlowLoopOpenInput): FlowLoopHandle | undefined;
  /** Removes the probe specs a generator session left in the spec directory. Idempotent. */
  sweepProbes(): Promise<void>;
  /** Whether every one of these delivered specs holds the bytes whose last call passed. */
  isClosed(deliveredSpecs: readonly string[]): Promise<boolean>;
  signals(): ClosedLoopSignals;
  /** Revokes the right, removes the probes and the data the calls left. Never throws. */
  close(): Promise<void>;
}
