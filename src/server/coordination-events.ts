/*
 * The coordination ledger's projection for the SIGNALS panel: a pure function over the events the engine's ledger
 * reader returns (qa-engine coordination/infrastructure/adapters/coordination-ledger-reader.adapter.ts), which
 * wire-app.ts wires to the ledger path.
 */
import type { CoordinationSignals } from "../contract/commands";
import { DELEGATION_FAILURE_CLASSES, type CoordinationLedgerEvent } from "../../qa-engine/src/contexts/coordination/application/index";

const CONTRACT_FAILURE_CLASSES: ReadonlySet<string> = new Set(DELEGATION_FAILURE_CLASSES);

/*
 * toCoordinationSignals aggregates the ledger into the SIGNALS panel block. Sample =
 * events belonging to runs the fleet executed (the caller decides the window). A
 * DelegationOutcome is the run-scoped boundary (one per run), so delegate share is the
 * share of outcome events whose action is "delegate".
 */
export function toCoordinationSignals(events: readonly CoordinationLedgerEvent[]): CoordinationSignals {
  const delegationEvents = events.filter((e) => e.kind === "delegation");
  const outcomes = events.filter((e) => e.kind === "outcome");
  const runIds = new Set(outcomes.map((e) => e.runId));
  const delegateRunIds = new Set(outcomes.filter((e) => e.action === "delegate").map((e) => e.runId));
  /*
   * A delegation contract failure is read from the typed failureClass field (set by
   * classifyDelegationFailure in qa-engine — "failed" | "blocked" | "claimed-files-missing"), never
   * guessed from the free-text `reason` prose. The prose only ever reads "sidekick status=<X>" and
   * a regex over it could never distinguish, say, a pushback-blocked delegation from a completed one
   * whose claimed files never verified on disk. Only a delegation failure class counts: a line with no
   * failureClass, or with a value outside that set (older ledgers wrote "fail" on every fix-loop
   * delegation, successful ones included), has no opinion and is not counted.
   */
  const failures = delegationEvents.filter(
    (e) => e.failureClass !== undefined && CONTRACT_FAILURE_CLASSES.has(e.failureClass),
  ).length;
  const timed = delegationEvents.filter((e) => typeof e.durationMs === "number");
  const totalRuns = runIds.size;
  const delegateRuns = delegateRunIds.size;
  return {
    measured: outcomes.length > 0,
    totalRuns,
    delegateRuns,
    contractFailureRate: delegationEvents.length > 0
      ? round4(failures / delegationEvents.length)
      : null,
    avgDelegationMs: timed.length > 0
      ? Math.round(timed.reduce((s, e) => s + (e.durationMs ?? 0), 0) / timed.length)
      : null,
  };
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
