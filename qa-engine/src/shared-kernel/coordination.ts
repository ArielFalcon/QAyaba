/* How a run is coordinated, as the layers around it share it: the limits of the lead/sidekick coordination and what a run records about it. */

/* The value a run's coordination signal records as its mode: lead + sidekicks is the only coordination. Records stored before that carry "single" too, so readers treat the field as a string. */
export const COORDINATION_SIGNAL_MODE = "lead-sidekicks" as const;

/* The shapes of the plan a lead emits when it is asked for one. */
/* The tools a lead's planning session is denied, plan and review alike: it plans from the Context Pack and the code graph, and DEV is read by the sidekicks that author the flows. */
export const LEAD_PLAN_DENIED_TOOLS: readonly string[] = ["playwright*", "authbrowser*"];

export const LEAD_PLAN_KIND = {
  /* Nothing is worth a test; the lead says why. */
  NOOP: "noop",
  /* The change is one piece of work: the lead authors it itself. */
  SINGLE: "single",
  /* The change is several independent flows, each authored by a sidekick. */
  FANOUT: "fanout",
} as const;
export type LeadPlanKind = (typeof LEAD_PLAN_KIND)[keyof typeof LEAD_PLAN_KIND];

/* What the lead's planning turn is told about the plan it may give: the numbers the orchestrator will hold it to. */
export interface PlanningLimits {
  /* The most flows the plan may name. */
  maxFlows: number;
  /* The most flows that run at once. */
  maxParallel: number;
  /* The longest the planning turn may take. */
  budgetMs: number;
  /* The places the app declares, when it declares a location: a flow may name one. Absent: the plan names no location. */
  locations?: readonly string[];
  /* The pages of the app's map the change is linked to, in rank order (a template stands for its pages). Absent: the run linked none. */
  changeRoutes?: readonly string[];
}

/* The longest one flow may take, by the runtime its sidekick runs on. */
export interface FlowBudgets {
  opencode: number;
  codex: number;
}

export interface CoordinationSettings {
  /* The most flows that run at once. */
  maxParallel: number;
  /* The most flows a plan may name. */
  maxFlows: number;
  /* The longest the lead's planning turn may take. */
  planBudgetMs: number;
  flowBudgetMs: FlowBudgets;
}

export const DEFAULT_COORDINATION_SETTINGS: CoordinationSettings = {
  maxParallel: 3,
  maxFlows: 6,
  planBudgetMs: 180_000,
  flowBudgetMs: { opencode: 480_000, codex: 600_000 },
};

/* What a run records about its coordination. Persist-only: no verdict, gate or retirement reads it back. */
export interface CoordinationGateSignal {
  /* COORDINATION_SIGNAL_MODE for a new run; a record stored earlier may carry another string ("single"). */
  mode: string;
  /* What the lead's plan came to once admitted ("noop", "single" or "fanout"); absent when the run asked for no plan. */
  plan?: string;
  /* Why a plan that asked for a fan-out went back to the lead as one piece of work. */
  downgrade?: string;
  /* Flows the plan named, flows that delivered a spec, and flows that did not finish. */
  flows: number;
  delivered: number;
  incomplete: number;
  /* Whether the lead took over a flow its sidekick could not finish. */
  takeover: boolean;
  /* What the sidekicks authored with ("authenticated-browser", "run-spec-only", "unauthenticated-browser", or why none ran). */
  authoring?: string;
  /* The lead's review of the flows: its turns, the decisions admitted, and those the orchestrator refused. Absent when the lead reviewed nothing. */
  review?: { turns: number; accepted: number; revised: number; replaced: number; dropped: number; refused: number };
  /* The reviewer's corrections the lead routed: its turns, the findings sent to flows and those no flow took, the flows revised or replaced, and the findings it rebutted. Absent when there was none. */
  corrections?: { turns: number; routed: number; unrouted: number; revised: number; replaced: number; rebutted: number };
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
    maxFlows: configured?.maxFlows ?? d.maxFlows,
    planBudgetMs: configured?.planBudgetMs ?? d.planBudgetMs,
    flowBudgetMs: {
      opencode: configured?.flowBudgetMs?.opencode ?? d.flowBudgetMs.opencode,
      codex: configured?.flowBudgetMs?.codex ?? d.flowBudgetMs.codex,
    },
  };
}
