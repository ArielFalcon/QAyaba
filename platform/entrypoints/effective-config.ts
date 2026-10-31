/*
 * What a run actually ran with (docs/observability-design.md section 14, `effectiveConfig`).
 *
 * The settings that decide a run are resolved ONCE, when the run starts, and stored on the run (`runs.effective_config`): a reader never
 * recomputes them from the app's or the process's current configuration, which may have changed since. The roles the run invoked
 * (provider, model, step limit) are read from the run's own recorded agent turns, which carry what the runtime reported live.
 *
 * A request's campaign labels are not an input here: they never decide any of this (section 14, "variant labels never change behaviour").
 * The presence of its campaign is: the run is frozen (run-freeze.ts), and the record says so.
 */

import { isCaptureMode, type CaptureMode } from "@kernel/telemetry/capture-mode";
import { agentsOfTurns, decideRunFreeze, recordRunConfig, type RunConfigEnvironment, type RunConfigRequest as EngineRunConfigRequest } from "@contexts/run-orchestration/application/index";
import type { ValidatedAppConfig as AppConfig } from "@contexts/app-catalog/application/index";
import type { EffectiveConfig, GroundingInput } from "./contract/commands";
import type { AgentRoleFacts } from "../persistence/repositories/telemetry.repository";

/* The part of the configuration fixed when the run starts. `agents` is not in it: it comes from the turns the run recorded. */
export type StoredRunConfig = Omit<EffectiveConfig, "agents">;

export type { RunConfigEnvironment } from "@contexts/run-orchestration/application/index";
export { configInEffect } from "@contexts/run-orchestration/application/index";

export interface RunConfigRequest extends EngineRunConfigRequest {
  /* Only its presence is read (run-freeze.ts). */
  campaign?: unknown;
  grounding?: GroundingInput | undefined;
}

/* The run's recorded configuration: the engine's rules over the freeze the server decided from the request. */
export function resolveRunConfig(app: AppConfig, request: RunConfigRequest, captureMode: CaptureMode, env: RunConfigEnvironment): StoredRunConfig {
  return recordRunConfig(app, request, decideRunFreeze(request), captureMode, env);
}

const NOT_RECORDED: StoredRunConfig = {
  levers: { closedLoop: null, agentBrowser: null, captureMode: null },
  campaignFreeze: null,
  runtime: null,
  prompt: { staticHash: null },
  grounding: { stitcher: null, domPack: null, lessons: null },
  coverage: { mode: null, minRatio: null },
};

export function parseStoredRunConfig(json: string | null | undefined): StoredRunConfig | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as Partial<StoredRunConfig>;
    return {
      levers: { ...NOT_RECORDED.levers, ...(parsed.levers ?? {}) },
      campaignFreeze: parsed.campaignFreeze ?? null,
      runtime: parsed.runtime ?? null,
      prompt: { staticHash: parsed.prompt?.staticHash ?? null },
      /* Only the keys this version knows: a record written by an older one may carry others, which are left out. */
      grounding: {
        stitcher: parsed.grounding?.stitcher ?? null,
        domPack: parsed.grounding?.domPack ?? null,
        lessons: parsed.grounding?.lessons ?? null,
      },
      coverage: { ...NOT_RECORDED.coverage, ...(parsed.coverage ?? {}) },
    };
  } catch {
    return undefined;
  }
}

export interface RecordedRunFacts {
  coverageMode: string | null;
  coverageMinRatio: number | null;
  /* The `runs.capture_mode` column: known even for a run whose configuration was not recorded. */
  captureMode: string | null;
}

/*
 * The run's effectiveConfig as served. The configuration fixed at the start is the record; the coverage policy the engine reported when the
 * run ended (the run-time columns grading reads) wins over it where both exist. A run that recorded nothing (it predates this field)
 * answers every key as null.
 */
export function buildEffectiveConfig(stored: StoredRunConfig | undefined, turns: readonly AgentRoleFacts[], facts: RecordedRunFacts | undefined): EffectiveConfig {
  const base = stored ?? NOT_RECORDED;
  return {
    ...base,
    levers: { ...base.levers, captureMode: base.levers.captureMode ?? (isCaptureMode(facts?.captureMode) ? facts.captureMode : null) },
    agents: agentsOfTurns(turns),
    coverage: { mode: facts?.coverageMode ?? base.coverage.mode, minRatio: facts?.coverageMinRatio ?? base.coverage.minRatio },
  };
}
