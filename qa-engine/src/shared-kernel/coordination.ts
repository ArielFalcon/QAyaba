/* How a run is coordinated, as the layers around it share it: the limits of the lead/sidekick coordination and what a run records about it. */

import type { OwnedSliceSize, UseCaseCandidate } from "./use-case-candidate.ts";
import type { ChangedDecision } from "./changed-decision.ts";

/* The shapes of the plan a lead emits when it is asked for one. */
export const LEAD_PLAN_KIND = {
  /* Nothing is worth a test; the lead says why. */
  NOOP: "noop",
  /* The change is several independent flows, each authored by a sidekick. */
  FANOUT: "fanout",
} as const;
export type LeadPlanKind = (typeof LEAD_PLAN_KIND)[keyof typeof LEAD_PLAN_KIND];

/* What the lead's planning turn is told about the plan it may give: the numbers the orchestrator will hold it to. */
export interface PlanningLimits {
  /* The flows the run can author (the flows that run at once x the full flow budgets left in the run, bounded by the app's ceiling); a plan's flows past it are not admitted and are asked of the lead again. Absent: nothing bounds them. */
  capacity?: number;
  /* The most flows that run at once. */
  maxParallel: number;
  /* The longest one flow may take. */
  flowBudgetMs?: number;
  /* The longest the planning turn may take. */
  budgetMs: number;
  /* The places the app declares, when it declares a location: a flow may name one. Absent: the plan names no location. */
  locations?: readonly string[];
  /* The use cases the plan must cover or drop with a reason (the admission set), in the order they are offered. Absent: the run derived none. */
  candidates?: readonly UseCaseCandidate[];
  /* How many less direct use cases the change reaches that the plan is not required to cover. */
  otherCandidates?: number;
  /* The part of the change each candidate's flow would own (its owned slice), by candidate id: so the lead groups candidates into flows of a workable size. */
  candidateSlices?: Readonly<Record<string, OwnedSliceSize>>;
  /* The decisions on the changed lines of the run's own diff, from the static listing: the plan's diff shows the hunks holding one first. Absent: none was listed. */
  decisions?: readonly ChangedDecision[];
}

export type { OwnedSliceSize };

/* The longest one flow may take, by the runtime its sidekick runs on. */
export interface FlowBudgets {
  opencode: number;
}

export interface CoordinationSettings {
  /* The most flows that run at once. */
  maxParallel: number;
  /* The app's ceiling on flows, for cost; absent: the run's time alone bounds them. */
  maxFlows?: number;
  /* The longest the lead's planning turn may take. */
  planBudgetMs: number;
  flowBudgetMs: FlowBudgets;
}

export const DEFAULT_COORDINATION_SETTINGS: CoordinationSettings = {
  maxParallel: 3,
  planBudgetMs: 180_000,
  flowBudgetMs: { opencode: 480_000 },
};

/*
 * Why no author sidekick could run, as the code a refused run records. A plan the orchestrator does not admit carries the plan's own reason after
 * the colon (`plan-rejected:<reason>`).
 */
export const AUTHORING_REFUSAL = {
  /* No coordinator is wired for a run that generates e2e specs. */
  NO_COORDINATOR: "no-coordinator",
  /* The coordination threw. */
  COORDINATION_FAILED: "coordination-failed",
  /* The generation cannot ask the lead for a plan. */
  CANNOT_PLAN: "cannot-plan",
  /* The run was granted neither the authenticated browser nor run_spec for an app with a login, so a sidekick would author against the login wall. */
  NO_AUTHOR_GRANT: "no-author-grant",
  /* Too little of the run is left to plan and author in parallel. */
  NO_TIME: "no-time",
  /* The planning turn ran out of its time. */
  PLAN_TIMED_OUT: "plan-timed-out",
  /* The plan was not admitted: the code is followed by the reason. */
  PLAN_REJECTED: "plan-rejected",
} as const;

/* What a run records about its coordination. Persist-only: no verdict, gate or retirement reads it back. */
export interface CoordinationGateSignal {
  /* What the lead's plan came to once admitted ("noop" or "fanout"); absent when the run asked for no plan. */
  plan?: string;
  /* Why no author sidekick could run (an `AUTHORING_REFUSAL` code); absent when authors ran. */
  refusal?: string;
  /* Flows the plan named, flows that delivered a spec, and flows that did not finish. */
  flows: number;
  delivered: number;
  incomplete: number;
  /* What the sidekicks authored with ("authenticated-browser", "run-spec-only", "unauthenticated-browser", or why none ran). */
  authoring?: string;
  /* The flows the run could author when its plan was admitted; absent when nothing bounded them. */
  capacity?: number;
  /* The flows of the plan past that capacity after the lead was asked about them, by id: not authored. Absent when there was none. */
  notAdmitted?: string[];
  /* The admitted flows whose owned change alone does not fit an author's window after the lead was asked to split them, by id. Absent when there was none. */
  oversize?: string[];
  /* The flows whose brief, with all their change named by reference, was still over the author's known window, by id: not sent, and counted incomplete. Absent when there was none. */
  overWindow?: string[];
  /* The drops the run's facts contradicted (a code file with added lines, no spec linked) that the lead kept when asked once more, per candidate: honored, never an error, counted by graders and the campaign report. Absent when there was none. */
  dropsContradicted?: Array<{ candidate: string; basis: string; why: string }>;
  /* The lead's review of the flows: its turns, the decisions admitted, and those the orchestrator refused. Absent when the lead reviewed nothing. */
  review?: { turns: number; accepted: number; revised: number; replaced: number; dropped: number; refused: number };
  /* The reviewer's corrections the lead routed: its turns, the findings sent to flows and those no flow took, the flows revised or replaced, and the findings it rebutted, and the maintenance flows it opened for specs no flow of the plan owns. Absent when there was none. */
  corrections?: { turns: number; routed: number; unrouted: number; revised: number; replaced: number; rebutted: number; maintained?: number };
}

/* The settings an app declared, with every limit it left out taken from the defaults. */
export function resolveCoordinationSettings(configured?: {
  maxParallel?: number;
  maxFlows?: number;
  planBudgetMs?: number;
  flowBudgetMs?: Partial<FlowBudgets>;
}): CoordinationSettings {
  const d = DEFAULT_COORDINATION_SETTINGS;
  return {
    maxParallel: configured?.maxParallel ?? d.maxParallel,
    ...(configured?.maxFlows !== undefined ? { maxFlows: configured.maxFlows } : {}),
    planBudgetMs: configured?.planBudgetMs ?? d.planBudgetMs,
    flowBudgetMs: {
      opencode: configured?.flowBudgetMs?.opencode ?? d.flowBudgetMs.opencode,
    },
  };
}
