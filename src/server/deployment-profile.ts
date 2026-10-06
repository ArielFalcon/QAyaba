/*
 * Deployment profile: which PERIPHERAL side effects this installation may perform. Selected by
 * QAYABA_PROFILE. The profile never changes decision logic (classification, gates, coverage,
 * publish decision, stitcher) — only the effectors that act after a decision or outside a run.
 *
 *   full (default) — GitHub-integrated: PR/Issue publication, self-maintenance, GitHub login.
 *   slim           — hermetic restricted-network install: the publish decision is materialized as
 *                    a local export (patch + MR/Issue bodies) for a human to submit, the
 *                    self-maintainer never runs, GitHub login is not offered, and secrets pasted at
 *                    run time (the daily LLM key) stay in memory instead of a file in the container,
 *                    and only the opencode agent provider is offered (the image ships no codex CLI),
 *                    and a run is refused while the agent's key is missing or not the one this process masks.
 *
 * Deployment-specific, not app-specific: nothing here names or branches on a watched app.
 */

import { join } from "node:path";
import type { AgentProvider } from "../agent-runtime/types";

export type DeploymentProfile = "full" | "slim";

export interface ProfileCapabilities {
  /* PR/Issue/branch push against the SCM host. Off → local export under data/exports. */
  remotePublication: boolean;
  /* qa-maintainer diagnosis + autonomous fix PR + hot-swap. */
  selfMaintenance: boolean;
  /* GitHub OAuth device-flow login for the console. */
  githubLogin: boolean;
  /* Secrets applied at run time (API keys pasted in the console) are written to the .env file. Off → memory only. */
  persistRuntimeSecrets: boolean;
  /* The agent providers this install can run: the image of an install that ships no codex CLI offers only opencode. */
  agentProviders: readonly AgentProvider[];
  /* A run is refused (as an infrastructure error, before any engine work) while an assigned agent provider is not ready: it needs configuration (no key this process can mask in logs, or not the key the agent holds) or it has failed (its gateway rejected the key, or it cannot be reached). Off → the run itself reports an unusable agent. */
  gateRunsOnAgentReadiness: boolean;
}

const CAPABILITIES: Record<DeploymentProfile, ProfileCapabilities> = {
  full: { remotePublication: true, selfMaintenance: true, githubLogin: true, persistRuntimeSecrets: true, agentProviders: ["opencode", "codex"], gateRunsOnAgentReadiness: false },
  slim: { remotePublication: false, selfMaintenance: false, githubLogin: false, persistRuntimeSecrets: false, agentProviders: ["opencode"], gateRunsOnAgentReadiness: true },
};

/* An unknown value throws: a typo must not silently fall back to the profile that pushes to a remote. */
export function resolveDeploymentProfile(env: NodeJS.ProcessEnv): DeploymentProfile {
  const raw = env.QAYABA_PROFILE?.trim().toLowerCase();
  if (!raw || raw === "full") return "full";
  if (raw === "slim") return "slim";
  throw new Error(`QAYABA_PROFILE must be "full" or "slim" (got ${JSON.stringify(env.QAYABA_PROFILE)})`);
}

export function profileCapabilities(profile: DeploymentProfile): ProfileCapabilities {
  return CAPABILITIES[profile];
}

/* Root of the local publication exports: <root>/<app>/<run namespace>/. */
export function exportRoot(env: NodeJS.ProcessEnv): string {
  return env.QAYABA_EXPORT_DIR?.trim() || join(env.QAYABA_ROOT ?? process.cwd(), "data", "exports");
}
