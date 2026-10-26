/*
 * What the lead planned for a run, kept per run so that a run can be graded after the fact against the change: the plan the orchestrator
 * admitted (its flows, their objectives, acceptance and pages), the change pages the planning turn was told and which of them no flow
 * visits, and how each flow ended. The plan is the lead's untrusted answer as admitted (already bounded by `admitLeadPlan`); its text goes
 * through the outbound sanitizer before it is kept. Metadata for grading, never read back by the engine.
 *
 * Total by contract: recording never fails a run, and the default does nothing. A run's plan is recorded when it is admitted and again,
 * with the flows' outcomes, when its flows end: the last record of a run is the one kept.
 */

export const PLAN_SNAPSHOT_KIND = {
  NOOP: "noop",
  REJECTED: "rejected",
  FANOUT: "fanout",
} as const;
export type PlanSnapshotKind = (typeof PLAN_SNAPSHOT_KIND)[keyof typeof PLAN_SNAPSHOT_KIND];

export interface PlanSnapshotFlow {
  id: string;
  objective: string;
  acceptance: string[];
  /* The pages the flow said it visits. */
  routes: string[];
  /* Relative to the spec directory. */
  specFile: string;
  /* The change pages this flow visits, as the orchestrator matched them. */
  visits: string[];
  /* The ids of the use cases the flow cited. */
  candidates: string[];
  /* How the flow ended; absent while its flows have not ended. */
  outcome?: { kind: string; reason?: string; specs?: string[] };
}

/* What became of a use case the plan had to answer for: a flow covers it, the lead dropped it with a reason, or the plan left it unplanned after the re-plan. */
export type PlanCandidateState = "planned" | "dropped" | "unplanned";

export interface PlanSnapshotCandidate {
  id: string;
  tier: string;
  reachability: string;
  state: PlanCandidateState;
  /* The lead's reason, for a dropped candidate. */
  reason?: string;
}

export interface PlanSnapshot {
  runId: string;
  kind: PlanSnapshotKind;
  /* Why the plan is a no-op or was not admitted. */
  reason?: string;
  /* The pages of the app's map the change is linked to, as the planning turn was told them. */
  changeRoutes: string[];
  /* The change pages no admitted flow visits. */
  unvisited: string[];
  /* The use cases the plan had to answer for (the admission set) and what became of each; empty when the plan is not a flow plan. */
  candidates: PlanSnapshotCandidate[];
  flows: PlanSnapshotFlow[];
  /* Wall-clock ms. */
  recordedAt: number;
}

export interface PlanSnapshotPort {
  record(snapshot: PlanSnapshot): void;
}

export const NO_PLAN_SNAPSHOTS: PlanSnapshotPort = { record: () => {} };

/** The port that sanitizes every text the lead wrote before `port` keeps it. */
export function sanitizedPlanSnapshots(port: PlanSnapshotPort, sanitize: (text: string) => string): PlanSnapshotPort {
  return {
    record: (snapshot) =>
      port.record({
        ...snapshot,
        ...(snapshot.reason !== undefined ? { reason: sanitize(snapshot.reason) } : {}),
        candidates: snapshot.candidates.map((candidate) => (candidate.reason !== undefined ? { ...candidate, reason: sanitize(candidate.reason) } : candidate)),
        flows: snapshot.flows.map((flow) => ({
          ...flow,
          objective: sanitize(flow.objective),
          acceptance: flow.acceptance.map(sanitize),
          ...(flow.outcome ? { outcome: { ...flow.outcome, ...(flow.outcome.reason !== undefined ? { reason: sanitize(flow.outcome.reason) } : {}) } } : {}),
        })),
      }),
  };
}
