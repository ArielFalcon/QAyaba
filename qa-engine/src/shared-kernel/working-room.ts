/*
 * The working room a turn needs on top of its prompt: the context its own steps add (every tool result and every answer stays in the
 * session). It is estimated from the telemetry of real turns, never taken as a fixed share of the window:
 *   room = growth per step x usual steps, per role.
 * A recorded turn gives one sample: its session grew from the prompt to its final context (the last message's input plus cache-read
 * tokens) over the steps it used. The usual figures are the upper quartile of the role's samples, so a few cheap turns do not shrink
 * the room. A role with fewer than MIN_HISTORY_SAMPLES samples starts cold: its usual steps are the live step limit the runtime
 * enforces (the worst case a turn can run) and its growth per step is COLD_START_STEP_GROWTH_TOKENS. A role with neither history nor a
 * step limit has no estimate (undefined), and a caller treats that as unknown.
 */
import { AGENT_ROLES, type AgentRole } from "./agent-role.ts";

/* A role needs this many samples before its own history replaces the cold start. */
export const MIN_HISTORY_SAMPLES = 3;

/*
 * The cold-start growth of one step: a step appends a tool result (a file read, a graph answer, a browser snapshot) and the model's
 * own output to the session. 2,000 tokens (about 8 KB) is an estimator for that sum, not a measurement: it is replaced by the
 * measured growth as soon as a role has MIN_HISTORY_SAMPLES recorded turns.
 */
export const COLD_START_STEP_GROWTH_TOKENS = 2_000;

/* The share of a role's samples at or below the figure used: the upper quartile. */
export const USUAL_PERCENTILE = 75;

export interface TurnSample {
  readonly role: AgentRole;
  readonly stepsUsed: number;
  /* The prompt the turn started from, in tokens. */
  readonly promptTokens: number;
  /* The session's size at its last message, in tokens. */
  readonly finalContextTokens: number;
}

export interface RoleWorkingRoom {
  readonly growthTokensPerStep: number;
  readonly steps: number;
  readonly basis: "history" | "cold-start";
  /* The recorded turns the figures come from (0 on a cold start). */
  readonly samples: number;
}

/* undefined: no estimate for the role. */
export interface WorkingRoomEstimate {
  forRole(role: AgentRole): RoleWorkingRoom | undefined;
}

/* A recorded agent turn as the history holds it; a column an older row lacks is null. */
export interface RecordedTurn {
  readonly role: AgentRole;
  readonly stepsUsed: number | null;
  /* The prompt the turn started from, in tokens (a caller converts the bytes it recorded with the estimator of context-budget). */
  readonly promptTokens: number | null;
  readonly tokensInput: number | null;
  readonly tokensCacheRead: number | null;
}

/* A turn is a sample only when it used steps and recorded its final context. */
export function turnSample(turn: RecordedTurn): TurnSample | undefined {
  if (turn.stepsUsed === null || turn.stepsUsed < 1 || turn.promptTokens === null) return undefined;
  if (turn.tokensInput === null && turn.tokensCacheRead === null) return undefined;
  return {
    role: turn.role,
    stepsUsed: turn.stepsUsed,
    promptTokens: turn.promptTokens,
    finalContextTokens: (turn.tokensInput ?? 0) + (turn.tokensCacheRead ?? 0),
  };
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export interface EstimateWorkingRoomInput {
  readonly turns: readonly TurnSample[];
  /* The live step limit of a role this run; undefined when the runtime states none. */
  readonly stepLimitFor: (role: AgentRole) => number | undefined;
}

export function estimateWorkingRoom({ turns, stepLimitFor }: EstimateWorkingRoomInput): WorkingRoomEstimate {
  const byRole = new Map<AgentRole, RoleWorkingRoom | undefined>();
  for (const role of AGENT_ROLES) byRole.set(role, roomOf(role));
  return { forRole: (role) => byRole.get(role) };

  function roomOf(role: AgentRole): RoleWorkingRoom | undefined {
    const own = turns.filter((t) => t.role === role && t.stepsUsed >= 1);
    if (own.length >= MIN_HISTORY_SAMPLES) {
      const growth = own.map((t) => Math.max(0, t.finalContextTokens - t.promptTokens) / t.stepsUsed);
      return {
        growthTokensPerStep: Math.ceil(percentile(growth, USUAL_PERCENTILE)),
        steps: percentile(own.map((t) => t.stepsUsed), USUAL_PERCENTILE),
        basis: "history",
        samples: own.length,
      };
    }
    const limit = stepLimitFor(role);
    return limit === undefined ? undefined : { growthTokensPerStep: COLD_START_STEP_GROWTH_TOKENS, steps: limit, basis: "cold-start", samples: 0 };
  }
}
