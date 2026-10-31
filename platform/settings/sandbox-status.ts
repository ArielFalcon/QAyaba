/* The operator's switches and status files of the execution sandbox's two boundaries, read from the environment: whether the egress filter must hold (QA_EGRESS_MODE), and where the boot checks leave their status (QA_FILE_BOUNDARY_STATUS_FILE, QA_EGRESS_STATUS_FILE). What the service makes of a status is the composition root's (platform/composition/file-boundary.ts, egress-wiring.ts). */

import { readFileSync } from "node:fs";

export type EgressMode = "enforce" | "warn";

/* QA_EGRESS_MODE: `enforce` (the default) ends a run that would execute agent code without the filter; `warn` lets it run unfiltered and says so in the run's gate signals. */
export function resolveEgressMode(env: NodeJS.ProcessEnv): EgressMode {
  const raw = env.QA_EGRESS_MODE;
  if (raw === undefined || raw === "") return "enforce";
  if (raw === "enforce" || raw === "warn") return raw;
  throw new Error(`QA_EGRESS_MODE must be "enforce" or "warn", got ${JSON.stringify(raw)}`);
}

export function fileBoundaryStatusFile(env: NodeJS.ProcessEnv): string {
  return env.QA_FILE_BOUNDARY_STATUS_FILE && env.QA_FILE_BOUNDARY_STATUS_FILE !== "" ? env.QA_FILE_BOUNDARY_STATUS_FILE : "/run/qa-file-boundary.status";
}

export function egressStatusFile(env: NodeJS.ProcessEnv): string {
  return env.QA_EGRESS_STATUS_FILE && env.QA_EGRESS_STATUS_FILE !== "" ? env.QA_EGRESS_STATUS_FILE : "/run/qa-egress.status";
}

/* The file boundary's status as the boot check left it; a missing file reads as nothing, which never counts as a boundary that holds. */
export function readFileBoundaryStatusFile(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return readFileSync(fileBoundaryStatusFile(env), "utf8");
  } catch {
    return undefined;
  }
}
