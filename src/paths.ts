import { join } from "node:path";

/* The orchestrator's root (config/, data/, .env): QAYABA_ROOT, else the working directory. */
export function qayabaRoot(): string {
  return process.env.QAYABA_ROOT ?? process.cwd();
}

/*
 * The data directory under the root (the qa-data volume): run history, logs, auth material and
 * telemetry. The agents container never mounts it.
 */
export function qayabaDataDir(): string {
  return join(qayabaRoot(), "data");
}

/*
 * The directory under the mirrors root that holds an experiment's throwaway working copies (the plain-agent
 * baseline of scripts/baseline-agent.ts). It is not a repo's mirror, so the mirror pruning must leave it alone.
 */
export const EXPERIMENT_COPIES_DIR = ".baseline";

/*
 * The directory under the mirrors root that holds an experiment's warm-start snapshots of a suite's `e2e/`
 * (scripts/warm-suite.ts), one folder per app and label. It is not a repo's mirror, so the mirror pruning
 * must leave it alone.
 */
export const WARM_SNAPSHOTS_DIR = ".warm";

/*
 * The directory under the mirrors root that holds the workspaces of a run's sidekicks, one folder per run and delegation
 * (qa-run-orchestration's delegation workspace). It is not a repo's mirror, so the mirror pruning must leave it alone: the
 * run that made a workspace removes it, and the sweep at boot and at the start of a run removes what a crash left.
 */
export const DELEGATIONS_DIR = ".qa-delegations";

/*
 * The empty directory under the mirrors root that the tool-less LLM-judge role opens its sessions in (src/server/judge-agent.ts).
 * It holds no repo and no file the judge could read; it exists because a session needs a directory the agents container can see.
 * It is not a repo's mirror, so the mirror pruning must leave it alone.
 */
export const JUDGE_WORKDIR = ".qa-judge";
