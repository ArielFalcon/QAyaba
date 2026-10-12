/* The composition root's side of the file boundary (qa-engine/src/shared-infrastructure/process-sandbox/file-boundary.ts): where the boot check leaves its status, what the service makes of it, and what the check tries. The status is read again at every spawn, like the egress filter's, and a missing one never counts as a boundary that holds. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFileBoundaryStatus, type FileBoundaryLayout } from "../../qa-engine/src/shared-infrastructure/process-sandbox/file-boundary";
import type { FileBoundaryGate } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox";
import { apiTokenPath, legacyApiTokenPath } from "./api-token";

export function fileBoundaryStatusFile(env: NodeJS.ProcessEnv): string {
  return env.QA_FILE_BOUNDARY_STATUS_FILE && env.QA_FILE_BOUNDARY_STATUS_FILE !== "" ? env.QA_FILE_BOUNDARY_STATUS_FILE : "/run/qa-file-boundary.status";
}

function egressStatusFile(env: NodeJS.ProcessEnv): string {
  return env.QA_EGRESS_STATUS_FILE && env.QA_EGRESS_STATUS_FILE !== "" ? env.QA_EGRESS_STATUS_FILE : "/run/qa-egress.status";
}

export function readFileBoundaryStatusFile(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return readFileSync(fileBoundaryStatusFile(env), "utf8");
  } catch {
    return undefined;
  }
}

/* The gate the launcher asks before every spawn. */
export function fileBoundaryGateFor(env: NodeJS.ProcessEnv, read: () => string | undefined = () => readFileBoundaryStatusFile(env)): FileBoundaryGate {
  return {
    breach() {
      const status = parseFileBoundaryStatus(read());
      return status.holds ? undefined : status.reason;
    },
  };
}

/* What the sandbox uid must not be able to do on this host, besides writing any mount under the root (found in the mount table, not listed here): read the service's environment and the API token, list the orchestrator's state, write its code, its config and the status files the service trusts. */
export function fileBoundaryLayout(env: NodeJS.ProcessEnv, root: string): FileBoundaryLayout {
  const data = join(root, "data");
  const config = join(root, "config");
  const mirrors = env.MIRROR_DIR && env.MIRROR_DIR !== "" ? env.MIRROR_DIR : join(root, ".mirrors");
  const graph = env.CBM_CACHE_DIR && env.CBM_CACHE_DIR !== "" ? env.CBM_CACHE_DIR : join(root, ".codebase-memory");
  return {
    appRoot: root,
    secretFiles: ["/proc/1/environ", apiTokenPath(root), legacyApiTokenPath(root)],
    closedDirs: [data, join(data, "auth"), config, join(config, "apps"), graph, mirrors],
    unwritable: [
      data,
      config,
      join(config, "apps"),
      join(config, "e2e"),
      join(config, "egress"),
      mirrors,
      graph,
      join(root, "src"),
      join(root, "qa-engine"),
      join(root, "bin"),
      join(root, "scripts"),
      join(root, "node_modules"),
      join(root, "package.json"),
      fileBoundaryStatusFile(env),
      egressStatusFile(env),
    ],
  };
}
