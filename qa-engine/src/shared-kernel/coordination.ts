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
