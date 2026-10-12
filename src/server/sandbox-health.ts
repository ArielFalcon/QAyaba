/* What /api/health says about the execution sandbox. A service whose sandbox cannot be honored still answers (so its container stays up for the operator to read why), but it says it is degraded: under QA_EXEC_SANDBOX=required with no sandbox uid, or under QA_EGRESS_MODE=enforce with the egress filter's boot self-test not passed, every run that executes agent code will end E-SANDBOX. */

import { readFileSync } from "node:fs";
import { resolveExecSandboxMode } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox";
import { resolveSandbox, type Sandbox } from "../../qa-engine/src/shared-infrastructure/process-sandbox/sandbox";
import { resolveEgressMode } from "./egress-wiring";

export interface SandboxHealth {
  degraded: boolean;
  isolation: "sandbox-uid" | "none";
  egress: "filtered" | "unfiltered" | "not-applicable";
  /* Why runs will end E-SANDBOX, or why they run weaker than configured; absent when nothing is wrong. */
  reason?: string;
}

export function describeSandboxHealth(env: NodeJS.ProcessEnv, deps: { sandbox?: Sandbox | null; readStatus?: () => string | undefined } = {}): SandboxHealth {
  const sandbox = deps.sandbox === undefined ? resolveSandbox(env) : deps.sandbox;
  const required = resolveExecSandboxMode(env) === "required";
  if (!sandbox) {
    return {
      degraded: required,
      isolation: "none",
      egress: "not-applicable",
      reason: required ? "QA_EXEC_SANDBOX=required but no sandbox uid is available: every run that executes agent code ends E-SANDBOX" : "no sandbox uid: agent code runs as the orchestrator's own user (QA_EXEC_SANDBOX=best-effort)",
    };
  }
  const statusFile = env.QA_EGRESS_STATUS_FILE && env.QA_EGRESS_STATUS_FILE !== "" ? env.QA_EGRESS_STATUS_FILE : "/run/qa-egress.status";
  const read = deps.readStatus ?? ((): string | undefined => {
    try {
      return readFileSync(statusFile, "utf8");
    } catch {
      return undefined;
    }
  });
  const status = read()?.trim();
  if (status === "ok") return { degraded: false, isolation: "sandbox-uid", egress: "filtered" };
  const enforce = resolveEgressMode(env) === "enforce";
  return {
    degraded: enforce,
    isolation: "sandbox-uid",
    egress: "unfiltered",
    reason: `the egress filter is not active (${status ?? "no boot self-test result"}): ${enforce ? "every run that executes agent code ends E-SANDBOX (QA_EGRESS_MODE=enforce)" : "agent code runs with this container's full network (QA_EGRESS_MODE=warn)"}`,
  };
}
