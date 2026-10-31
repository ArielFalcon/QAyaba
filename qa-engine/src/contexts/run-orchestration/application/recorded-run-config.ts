/*
 * What a run actually ran with (docs/observability-design.md section 14, `effectiveConfig`).
 *
 * The settings that decide a run are resolved ONCE, when the run starts, and recorded on the run: a reader never recomputes them from
 * the app's or the process's current configuration, which may have changed since. The roles the run invoked (provider, model, step
 * limit) are read from the run's own recorded agent turns, which carry what the runtime reported live.
 *
 * A request's campaign labels are not an input here: they never decide any of this (section 14, "variant labels never change behaviour").
 * Whether the run is frozen is: the shell decides it from the request and hands it in, and the record says so.
 */
import type { CaptureMode } from "@kernel/telemetry/capture-mode.ts";
import { resolveCoveragePolicy, type ChangeCoverageDeclaration } from "@contexts/objective-signal/application/index.ts";
import { agentBrowserEnabled, closedLoopEnabled, serviceTopologyWired } from "../domain/run-config-gates.ts";
import { resolveDomPack } from "../domain/run-policy.ts";

/* The part of the configuration fixed when the run starts. The roles are not in it: they come from the turns the run recorded. Every key a run recorded before the key existed reads as null. */
export interface RecordedRunConfig {
  levers: { closedLoop: boolean | null; agentBrowser: boolean | null; captureMode: CaptureMode | null };
  campaignFreeze: boolean | null;
  runtime: string | null;
  prompt: { staticHash: string | null };
  grounding: {
    stitcher: string | null;
    domPack: boolean | null;
    /* Whether the run read lessons (the learning arm). */
    lessons: boolean | null;
  };
  coverage: { mode: string | null; minRatio: number | null };
}

/* The part of an app's configuration the record reads. */
export interface RunConfigDeclaration {
  services?: readonly unknown[] | undefined;
  boundaries?: readonly unknown[] | undefined;
  qa: {
    closedLoop?: { enabled?: boolean | undefined } | undefined;
    agentBrowser?: { enabled?: boolean | undefined } | undefined;
    domPack?: boolean | undefined;
    changeCoverage?: ChangeCoverageDeclaration | undefined;
  };
}

/* The run's own choices (an A/B arm); every key absent means the app's setting. */
export interface RunConfigRequest {
  closedLoop?: boolean | undefined;
  agentBrowser?: boolean | undefined;
  grounding?: { stitcher?: boolean | undefined; domPack?: boolean | undefined; lessons?: boolean | undefined } | undefined;
}

/* Whether the run starts from a fixed state, and whether it reads the lessons earlier runs' observations teach. */
export interface RunFreezeFact {
  frozen: boolean;
  lessons: boolean;
}

/* The process-level facts a run's configuration depends on, read by the composition root (the engine never reads the environment). */
export interface RunConfigEnvironment {
  /* The agent runtime that authors specs for runs started now (the primary role's provider), or null when it cannot be told. */
  runtime(): string | null;
  /* Hash of the static prompt layers, or null when they cannot be read here. */
  staticPromptHash(): string | null;
  /* The run_spec and authenticated browser tools can be granted to a run (the service token is configured). */
  toolsGranted: boolean;
  /* The server's ceiling on content capture (QA_TELEMETRY_MAX_CAPTURE): no run, whatever it asks, captures more. */
  maxCapture: CaptureMode;
}

export function recordRunConfig(app: RunConfigDeclaration, request: RunConfigRequest, freeze: RunFreezeFact, captureMode: CaptureMode, env: RunConfigEnvironment): RecordedRunConfig {
  /* Same predicates as the composition's wiring (run-config-gates.ts). The tools also need the service token; otherwise the lever cannot take effect, whatever was asked. */
  const closedLoopAsked = request.closedLoop ?? closedLoopEnabled(app);
  const agentBrowserAsked = request.agentBrowser ?? agentBrowserEnabled(app);
  const stitched = serviceTopologyWired(app);
  const requestedGrounding = request.grounding ?? {};
  const coverage = resolveCoveragePolicy(app.qa.changeCoverage);
  return {
    levers: {
      closedLoop: env.toolsGranted && closedLoopAsked,
      agentBrowser: env.toolsGranted && agentBrowserAsked,
      captureMode,
    },
    campaignFreeze: freeze.frozen,
    runtime: env.runtime(),
    prompt: { staticHash: env.staticPromptHash() },
    grounding: {
      /* The service-topology collaborator is one of the two advisory structural signals: it exists only for an app with services and declared boundaries. */
      stitcher: stitched ? (requestedGrounding.stitcher === false ? "off" : "signal") : null,
      domPack: resolveDomPack(requestedGrounding.domPack, app.qa.domPack),
      lessons: freeze.lessons,
    },
    coverage: { mode: coverage.mode, minRatio: coverage.minRatio },
  };
}

/* What the run's trace root records about the configuration (the same facts). */
export interface RunConfigInEffect {
  runtime: string | null;
  closedLoop: boolean | null;
  agentBrowser: boolean | null;
  coveragePolicy: string | null;
  campaignFreeze: boolean | null;
  staticPromptHash: string | null;
  captureMode: string | null;
}

export function configInEffect(config: RecordedRunConfig): RunConfigInEffect {
  return {
    runtime: config.runtime,
    closedLoop: config.levers.closedLoop,
    agentBrowser: config.levers.agentBrowser,
    coveragePolicy: config.coverage.mode,
    campaignFreeze: config.campaignFreeze,
    staticPromptHash: config.prompt.staticHash,
    captureMode: config.levers.captureMode,
  };
}

/* One agent turn the run recorded, as far as the roles it invoked are concerned. */
export interface RecordedAgentTurn {
  role: string;
  provider: string | null;
  modelRequested: string | null;
  modelAnswered: string | null;
  maxSteps: number | null;
}

export interface RecordedAgent {
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
  stepLimit: number | null;
}

/* The roles a run invoked, from the turns it recorded: the last provider and model the runtime reported, and the largest step limit it stated. reasoningEffort is null: the runtime's live agent list does not carry it. */
export function agentsOfTurns(turns: readonly RecordedAgentTurn[]): Record<string, RecordedAgent> {
  const agents: Record<string, RecordedAgent> = {};
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
