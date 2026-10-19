/*
 * What a run actually ran with (docs/observability-design.md section 14, `effectiveConfig`).
 *
 * The settings that decide a run are resolved ONCE, when the run starts, and stored on the run (`runs.effective_config`): a reader never
 * recomputes them from the app's or the process's current configuration, which may have changed since. The roles the run invoked
 * (provider, model, step limit) are read from the run's own recorded agent turns, which carry what the runtime reported live.
 *
 * A request's campaign labels are not an input here: they never decide any of this (section 14, "variant labels never change behaviour").
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCoordinationSettings, type CoordinationMode } from "@kernel/coordination";
import type { TestTarget } from "@kernel/run-mode";
import { isCaptureMode, type CaptureMode } from "@kernel/telemetry/capture-mode";
import { serviceTopologyWired, structuralSignalsMode, toolsApply } from "./run-config-gates";
import type { AppConfig } from "../orchestrator/config-loader";
import type { EffectiveConfig, GroundingInput } from "../contract/commands";
import type { AgentRoleFacts } from "./history";
import type { RunConfigInEffect } from "./run-trace";

/* The part of the configuration fixed when the run starts. `agents` is not in it: it comes from the turns the run recorded. */
export type StoredRunConfig = Omit<EffectiveConfig, "agents">;

/* The process-level facts a run's configuration depends on, read by the composition root (qa-engine never reads the environment). */
export interface RunConfigEnvironment {
  /* The agent runtime that authors specs for runs started now (the primary role's provider), or null when it cannot be told. */
  runtime(): string | null;
  /* Hash of the static prompt layers, or null when they cannot be read here. */
  staticPromptHash(): string | null;
  /* The run_spec and authenticated browser tools can be granted to a run (the service token is configured). */
  toolsGranted: boolean;
  reflectorEnabled: boolean;
  campaignFrozen: boolean;
  /* The server's ceiling on content capture (QA_TELEMETRY_MAX_CAPTURE): no run, whatever it asks, captures more. */
  maxCapture: CaptureMode;
}

export interface RunConfigRequest {
  closedLoop?: boolean | undefined;
  agentBrowser?: boolean | undefined;
  coordinationMode?: CoordinationMode | undefined;
  grounding?: GroundingInput | undefined;
}

/* The engine's defaults for the change-coverage policy, restated by the composition root's own `??` chain. */
const DEFAULT_COVERAGE_MODE = "signal";
const DEFAULT_COVERAGE_MIN_RATIO = 0.7;

export function resolveRunConfig(app: AppConfig, target: TestTarget, request: RunConfigRequest, captureMode: CaptureMode, env: RunConfigEnvironment): StoredRunConfig {
  const isCode = target === "code";
  /* Same predicates as the engine factory's wiring (run-config-gates.ts). The tools also need the service token; otherwise the lever cannot take effect, whatever was asked. */
  const tools = toolsApply(target, app);
  const closedLoopAsked = request.closedLoop ?? app.qa.closedLoop?.enabled === true;
  const agentBrowserAsked = request.agentBrowser ?? app.qa.agentBrowser?.enabled === true;
  const structuralMode = structuralSignalsMode(app);
  const services = (app.services?.length ?? 0) > 0;
  const stitched = serviceTopologyWired(app);
  const requestedGrounding = request.grounding ?? {};
  return {
    levers: {
      closedLoop: tools ? env.toolsGranted && closedLoopAsked : null,
      agentBrowser: tools ? env.toolsGranted && agentBrowserAsked : null,
      coordinationMode: isCode ? null : (request.coordinationMode ?? resolveCoordinationSettings(app.qa.coordination).mode),
      captureMode,
    },
    campaignFreeze: env.campaignFrozen,
    runtime: env.runtime(),
    prompt: { staticHash: env.staticPromptHash() },
    grounding: {
      explorer: requestedGrounding.explorer ?? app.qa.explorer ?? services,
      /* The service-topology collaborator is one of the two advisory structural signals: it exists only for an app with services and declared boundaries. */
      stitcher: stitched ? (requestedGrounding.stitcher === false ? "off" : structuralMode) : null,
      structuralSignal: requestedGrounding.structuralSignal === false ? "off" : structuralMode,
      curriculum: env.campaignFrozen ? "frozen" : requestedGrounding.curriculum === false ? "off" : "learning",
    },
    coverage: { mode: app.qa.changeCoverage?.mode ?? DEFAULT_COVERAGE_MODE, minRatio: app.qa.changeCoverage?.minRatio ?? DEFAULT_COVERAGE_MIN_RATIO },
    reflector: env.reflectorEnabled && !env.campaignFrozen,
  };
}

/* What the run's trace root records about the configuration (the same facts). */
export function configInEffect(config: StoredRunConfig): RunConfigInEffect {
  return {
    runtime: config.runtime,
    coordinationMode: config.levers.coordinationMode,
    closedLoop: config.levers.closedLoop,
    agentBrowser: config.levers.agentBrowser,
    coveragePolicy: config.coverage.mode,
    reflector: config.reflector,
    campaignFreeze: config.campaignFreeze,
    staticPromptHash: config.prompt.staticHash,
    captureMode: config.levers.captureMode,
  };
}

const NOT_RECORDED: StoredRunConfig = {
  levers: { closedLoop: null, agentBrowser: null, coordinationMode: null, captureMode: null },
  campaignFreeze: null,
  runtime: null,
  prompt: { staticHash: null },
  grounding: { explorer: null, stitcher: null, structuralSignal: null, curriculum: null },
  coverage: { mode: null, minRatio: null },
  reflector: null,
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
      grounding: { ...NOT_RECORDED.grounding, ...(parsed.grounding ?? {}) },
      coverage: { ...NOT_RECORDED.coverage, ...(parsed.coverage ?? {}) },
      reflector: parsed.reflector ?? null,
    };
  } catch {
    return undefined;
  }
}

/* The roles a run invoked, from the turns it recorded: the last provider and model the runtime reported, and the largest step limit it stated. reasoningEffort is null: the runtime's live agent list does not carry it. */
export function agentsOfTurns(turns: readonly AgentRoleFacts[]): EffectiveConfig["agents"] {
  const agents: EffectiveConfig["agents"] = {};
  for (const turn of turns) {
    const current = agents[turn.role] ?? { provider: null, model: null, reasoningEffort: null, stepLimit: null };
    agents[turn.role] = {
      provider: turn.provider ?? current.provider,
      model: turn.modelAnswered ?? turn.modelRequested ?? current.model,
      reasoningEffort: null,
      stepLimit: turn.maxSteps === null ? current.stepLimit : Math.max(current.stepLimit ?? 0, turn.maxSteps),
    };
  }
  return agents;
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

/*
 * Hash of the static prompt layers as the orchestrator's own copy of the repository has them: `agents/AGENTS.md` and each role file
 * under `agents/agent/`, in name order. The agents container mounts the same folder read-only, so this is what it serves unless the
 * two checkouts differ; null when the files cannot be read here.
 */
export function hashStaticPrompts(root: string): string | null {
  try {
    const hash = createHash("sha256");
    const entries: Array<[string, string]> = [["AGENTS.md", join(root, "agents", "AGENTS.md")]];
    const roleDir = join(root, "agents", "agent");
    for (const name of readdirSync(roleDir).filter((n) => n.endsWith(".md")).sort()) entries.push([`agent/${name}`, join(roleDir, name)]);
    for (const [name, path] of entries) {
      hash.update(`${name}\0`);
      hash.update(readFileSync(path));
      hash.update("\0");
    }
    return `sha256:${hash.digest("hex")}`;
  } catch {
    return null;
  }
}
