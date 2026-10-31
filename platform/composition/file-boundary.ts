/* The composition root's side of the file boundary (engine/src/shared-infrastructure/process-sandbox/file-boundary.ts): what the service makes of the status the boot check leaves (platform/settings/sandbox-status.ts says where; the check, platform/entrypoints/file-boundary-check.ts, says what it tries). The status is read again at every spawn, like the egress filter's, and a missing one never counts as a boundary that holds. */

import { parseFileBoundaryStatus } from "../../engine/src/shared-infrastructure/process-sandbox/file-boundary";
import type { FileBoundaryGate } from "../../engine/src/shared-infrastructure/process-sandbox/exec-sandbox";
import { readFileBoundaryStatusFile } from "../settings/sandbox-status";

/* The gate the launcher asks before every spawn. */
export function fileBoundaryGateFor(env: NodeJS.ProcessEnv, read: () => string | undefined = () => readFileBoundaryStatusFile(env)): FileBoundaryGate {
  return {
    breach() {
      const status = parseFileBoundaryStatus(read());
      return status.holds ? undefined : status.reason;
    },
  };
}
