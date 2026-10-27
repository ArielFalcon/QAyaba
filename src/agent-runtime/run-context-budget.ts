/*
 * The context budget of ONE run: the windows the agent runtime reports for the models it serves, the model each role runs on, and the
 * working room estimated from the history of recorded turns. Every run builds its own, so two runs (or a runtime switched between
 * them) never read each other's windows. Until the run's first ask installs what the runtime reports, no window and no working room is
 * known, and the budget answers `unknown`.
 */
import { AGENT_ROLES, type AgentRole } from "@kernel/agent-role";
import { ContextBudget, tokensOfBytes } from "@kernel/context-budget";
import type { ContextWindowPort } from "@kernel/ports/context-window.port";
import { estimateWorkingRoom, turnSample, type TurnSample, type WorkingRoomEstimate } from "@kernel/working-room";
import { assignmentForRole, AGENT_NAME_FOR_ROLE, type AgentRuntimeConfig, type ModelWindows, type StepLimits } from "./types";

/* The recorded turns the working room is estimated from, newest first. */
export const WORKING_ROOM_HISTORY_TURNS = 400;

/* A positive whole window, else unknown. */
function positiveWindow(tokens: number | undefined): number | undefined {
  return tokens !== undefined && Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

/* The `provider/` a model reference carries, "" for a bare model id. */
function providerPrefix(modelRef: string): string {
  const slash = modelRef.indexOf("/");
  return slash < 0 ? "" : modelRef.slice(0, slash + 1);
}

/* The role a recorded turn ran as. A turn records the role or the agent name, depending on who opened its session. */
export function roleOfRecordedTurn(recorded: string): AgentRole | undefined {
  return AGENT_ROLES.find((role) => role === recorded || AGENT_NAME_FOR_ROLE[role] === recorded);
}

export interface RecordedTurnRow {
  readonly role: string;
  readonly stepsUsed: number | null;
  readonly promptBytes: number | null;
  readonly tokensInput: number | null;
  readonly tokensCacheRead: number | null;
}

/* The samples a history of recorded turns gives; a turn of an unknown role or without the figures is left out. */
export function samplesOfRecordedTurns(rows: readonly RecordedTurnRow[]): TurnSample[] {
  const samples: TurnSample[] = [];
  for (const row of rows) {
    const role = roleOfRecordedTurn(row.role);
    const sample = role ? turnSample({ ...row, role, promptTokens: row.promptBytes === null ? null : tokensOfBytes(row.promptBytes) }) : undefined;
    if (sample) samples.push(sample);
  }
  return samples;
}

export interface InstallRunContext {
  /* The windows the runtime reports, by `provider/model`; undefined when the read failed or the runtime reports none. */
  readonly windows: ModelWindows | undefined;
  /* The role -> model assignments live at install time. */
  readonly config: AgentRuntimeConfig | undefined;
  readonly stepLimits: StepLimits;
  /* The recorded turns; a history that cannot be read is an empty one (the room then starts cold). */
  readonly history: readonly RecordedTurnRow[];
}

export class RunContextBudget implements ContextWindowPort {
  private windows: ModelWindows = {};
  private config: AgentRuntimeConfig | undefined;
  private room: WorkingRoomEstimate = { forRole: () => undefined };
  readonly budget: ContextBudget;

  constructor() {
    this.budget = new ContextBudget(this, { forRole: (role) => this.room.forRole(role) });
  }

  install({ windows, config, stepLimits, history }: InstallRunContext): void {
    this.windows = windows ?? {};
    this.config = config;
    this.room = estimateWorkingRoom({ turns: samplesOfRecordedTurns(history), stepLimitFor: (role) => stepLimits[role] });
  }

  windowTokens(role: AgentRole, model?: string): number | undefined {
    const assigned = this.config ? assignmentForRole(this.config, role).model : undefined;
    if (model === undefined) return assigned === undefined ? undefined : positiveWindow(this.windows[assigned]);
    /* A model the caller picked: as written, else under the provider of the role's own model. */
    return positiveWindow(this.windows[model]) ?? (assigned === undefined ? undefined : positiveWindow(this.windows[`${providerPrefix(assigned)}${model}`]));
  }
}
