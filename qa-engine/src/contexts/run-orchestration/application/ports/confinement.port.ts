import type { ConfinementResult } from "../../domain/confinement-result.ts";
import type { WorkspaceHandle } from "../../domain/workspace-handle.ts";

/**
 * Detects and reverts agent writes outside the permitted area (e2e-target:
 * only e2e/ survives; code-target: any path except the denylist) and symlinks
 * whose realpath escapes the mirror root. This is the only context permitted
 * vcs writes. Absent: no enforce, no gateSignals.confinement.
 * A thrown enforce() (including a failed revert) MUST be caught by the caller,
 * logged, and recorded best-effort in gateSignals.confinement — never alter
 * the verdict or block publish. The adapter itself does not swallow git errors.
 */
export interface ConfinementPort {
  enforce(workspace: WorkspaceHandle, signal?: AbortSignal): Promise<ConfinementResult>;
}
