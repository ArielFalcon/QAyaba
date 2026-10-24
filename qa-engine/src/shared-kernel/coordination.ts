/* How a run is coordinated, as the layers around it share it: the mode an app or a run chooses, the limits of the lead/sidekick mode, and what a run records about it. */

export const COORDINATION_MODE = {
  /* The lead authors the whole change in one turn, as every run did before: no planning turn, no sidekick. The default, and the control arm of an A/B. */
  SINGLE: "single",
  /* The lead plans first; a plan of independent flows is authored by sidekicks in parallel, each closing its own run_spec loop, and the lead takes over what they cannot finish. */
  LEAD_SIDEKICKS: "lead-sidekicks",
} as const;
export type CoordinationMode = (typeof COORDINATION_MODE)[keyof typeof COORDINATION_MODE];

export function isCoordinationMode(value: unknown): value is CoordinationMode {
  return value === COORDINATION_MODE.SINGLE || value === COORDINATION_MODE.LEAD_SIDEKICKS;
}

/* The shapes of the plan a lead emits when it is asked for one. */
/* The tools a lead's planning session is denied, plan and review alike: it plans from the Context Pack and the code graph, and DEV is read by the sidekicks that author the flows. */
export const LEAD_PLAN_DENIED_TOOLS: readonly string[] = ["playwright*"];

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
}

/* The longest one flow may take, by the runtime its sidekick runs on. */
export interface FlowBudgets {
  opencode: number;
  codex: number;
}

export interface CoordinationSettings {
  mode: CoordinationMode;
  /* The most flows that run at once. */
  maxParallel: number;
  /* The most flows a plan may name. */
  maxFlows: number;
  /* The longest the lead's planning turn may take. */
  planBudgetMs: number;
  flowBudgetMs: FlowBudgets;
}

export const DEFAULT_COORDINATION_SETTINGS: CoordinationSettings = {
  mode: COORDINATION_MODE.SINGLE,
  maxParallel: 3,
  maxFlows: 6,
  planBudgetMs: 180_000,
  flowBudgetMs: { opencode: 480_000, codex: 600_000 },
};

/* What a run records about its coordination. Persist-only: no verdict, gate or retirement reads it back. */
export interface CoordinationGateSignal {
  mode: CoordinationMode;
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
  mode?: CoordinationMode;
  maxParallel?: number;
  maxFlows?: number;
  planBudgetMs?: number;
  flowBudgetMs?: Partial<FlowBudgets>;
}): CoordinationSettings {
  const d = DEFAULT_COORDINATION_SETTINGS;
  return {
    mode: configured?.mode ?? d.mode,
    maxParallel: configured?.maxParallel ?? d.maxParallel,
    maxFlows: configured?.maxFlows ?? d.maxFlows,
    planBudgetMs: configured?.planBudgetMs ?? d.planBudgetMs,
    flowBudgetMs: {
      opencode: configured?.flowBudgetMs?.opencode ?? d.flowBudgetMs.opencode,
      codex: configured?.flowBudgetMs?.codex ?? d.flowBudgetMs.codex,
    },
  };
}

/* The mode a run uses: its own choice when it made one (an A/B arm), else the app's setting. */
export function effectiveCoordinationMode(settings: Pick<CoordinationSettings, "mode">, override?: CoordinationMode): CoordinationMode {
  return override ?? settings.mode;
}
