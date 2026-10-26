/* Builds the run-orchestration context: the deploy gate, the run history, the run's configuration block and the pipeline that runs the flow over the ports the other contexts serve. */

import { engineLog } from "@kernel/ports/process-logger.ts";
import type { DeployGatePort } from "@kernel/ports/deploy-gate.port.ts";
import type { RunHistoryPort } from "../application/ports/run-history.port.ts";
import type { RunPipelinePort } from "../application/ports/run-pipeline.port.ts";
import type { RunQaConfig } from "../application/run-flow/run-types.ts";
import { DeployGatePortAdapter, NullDeployGateAdapter, type VersionPollFn } from "../infrastructure/adapters/deploy-gate-port.adapter.ts";
import { FileRunHistoryAdapter, InMemoryRunHistoryAdapter } from "../infrastructure/adapters/run-history-port.adapter.ts";
import { RunPipelineAdapter, type RunPipelineAdapterDeps } from "../infrastructure/run-pipeline.adapter.ts";

const DEFAULT_DEPLOY_GATE_INTERVAL_MS = 2000;
const DEFAULT_DEPLOY_GATE_TIMEOUT_MS = 60000;

/* The run's configuration as the flow reads it, plus the one live read the builder records once. */
export type RunConfigDeps = Omit<RunQaConfig, "reviewerIndependence"> & {
  /* Whether the reviewer runs the generator's own model: asked once when the run is wired. Absent, or throwing, records nothing. */
  reviewerIndependence?: () => "shared-model" | "distinct-model" | undefined;
};

export interface RunOrchestrationDeps {
  /* Every port the other contexts serve and the optional collaborators of the flow; the deploy gate, the history and the config are this context's own. */
  ports: Omit<RunPipelineAdapterDeps, "deployGate" | "companionDeployGates" | "runHistory" | "config">;
  config: RunConfigDeps;
  /* Absent versionUrl selects the gate that is always ready (static sites, the code target); present selects the poll loop. */
  deployGate: {
    versionUrl?: string;
    poll?: VersionPollFn;
    intervalMs?: number;
    timeoutMs?: number;
    /* The other repos of a run over several repos: one gate each, by repo. A repo without a versionUrl is not awaited. */
    companions?: ReadonlyArray<{ repo: string; versionUrl?: string; poll?: VersionPollFn; intervalMs?: number; timeoutMs?: number }>;
  };
  /* An explicit store wins over a file path; with neither, the history is held in memory. */
  history: { store?: RunHistoryPort; filePath?: string };
}

export interface RunOrchestrationApi {
  /* The flow's complete dependencies: what the pipeline is built over. */
  deps: RunPipelineAdapterDeps & Required<Pick<RunPipelineAdapterDeps, "deployGate" | "runHistory">>;
  pipeline: RunPipelinePort;
}

export function buildRunOrchestration(deps: RunOrchestrationDeps): RunOrchestrationApi {
  const { versionUrl } = deps.deployGate;
  const deployGate = versionUrl
    ? new DeployGatePortAdapter(deps.deployGate.poll ?? (async () => ({ serving: true })), {
        versionUrl,
        intervalMs: deps.deployGate.intervalMs ?? DEFAULT_DEPLOY_GATE_INTERVAL_MS,
        timeoutMs: deps.deployGate.timeoutMs ?? DEFAULT_DEPLOY_GATE_TIMEOUT_MS,
      })
    : new NullDeployGateAdapter();
  const companionDeployGates = new Map<string, DeployGatePort>();
  for (const c of deps.deployGate.companions ?? []) {
    if (!c.versionUrl) continue;
    companionDeployGates.set(c.repo, new DeployGatePortAdapter(c.poll ?? (async () => ({ serving: true })), {
      versionUrl: c.versionUrl,
      intervalMs: c.intervalMs ?? DEFAULT_DEPLOY_GATE_INTERVAL_MS,
      timeoutMs: c.timeoutMs ?? DEFAULT_DEPLOY_GATE_TIMEOUT_MS,
    }));
  }
  const runHistory = deps.history.store ?? (deps.history.filePath ? new FileRunHistoryAdapter(deps.history.filePath) : new InMemoryRunHistoryAdapter());
  const { reviewerIndependence: _read, ...config } = deps.config;
  const adapterDeps: RunOrchestrationApi["deps"] = {
    ...deps.ports,
    deployGate,
    ...(companionDeployGates.size > 0 ? { companionDeployGates } : {}),
    runHistory,
    config: { ...config, ...recordedReviewerIndependence(deps.config) },
  };
  return { deps: adapterDeps, pipeline: new RunPipelineAdapter(adapterDeps) };
}

/* The reviewer-independence fact of the run being wired; a runtime that cannot answer leaves the run without it, loudly. */
function recordedReviewerIndependence(config: RunConfigDeps): { reviewerIndependence?: "shared-model" | "distinct-model" } {
  if (!config.reviewerIndependence) return {};
  try {
    const value = config.reviewerIndependence();
    return value !== undefined ? { reviewerIndependence: value } : {};
  } catch (err) {
    engineLog.warn(`[qa] the reviewer's model assignment could not be read, so the run records no reviewer independence: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}
