/* The views of the active exec scope that the run flow reads through `ExecScopePort`: the scope lives in the process's async context, so every provider shares these. */

import type { ExecScopePort } from "../../shared-kernel/ports/exec-scope.port.ts";
import { isSandboxUnavailable } from "./exec-sandbox.ts";
import { activeExecScope, refusedScope, sandboxRefused, sandboxSignal, withExecScope } from "./exec-scope.ts";

export const ambientExecScope: Omit<ExecScopePort, "open"> = {
  activeExecScope,
  refusedScope,
  withExecScope,
  sandboxRefused,
  sandboxSignal,
  isSandboxUnavailable,
};
