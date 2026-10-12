/* A SandboxedBinaryRunner whose child is started by the execution launcher: the runner for work that executes agent-influenced code but wants a collected result (the e2e project's `npm ci`, the login discovery, the auth setup). It is the generic runner's capture, timeout and tree-kill, over a sandboxed child of one fixed profile.
   The request's `env` is a request, not an environment: the account (DEV_TEST_USER / DEV_TEST_PASS) becomes the launcher's `account`, which only the login profile honors, and everything else is checked against the launcher's extra-variable allowlist (a name outside it throws). The child's real environment is the profile's. */

import type { ProcessKillPort } from "../../shared-kernel/process-sandbox/process-kill.port.ts";
import type { SandboxProfile } from "./exec-env.ts";
import type { ExecSandboxPort } from "./exec-sandbox.ts";
import { SandboxedBinaryRunnerAdapter } from "./sandboxed-binary-runner.adapter.ts";
import type { SandboxedBinaryRunner } from "./sandboxed-binary-runner.ts";

export function createExecBinaryRunner(deps: { exec: ExecSandboxPort; profile: SandboxProfile; processKill: ProcessKillPort; maxOutputChars?: number }): SandboxedBinaryRunner {
  return new SandboxedBinaryRunnerAdapter({
    processKill: deps.processKill,
    ...(deps.maxOutputChars !== undefined ? { maxOutputChars: deps.maxOutputChars } : {}),
    launch: (req) => {
      const { DEV_TEST_USER: user, DEV_TEST_PASS: pass, ...extra } = req.env;
      return deps.exec.spawn(req.command, req.args, {
        cwd: req.cwd,
        profile: deps.profile,
        ...(Object.keys(extra).length > 0 ? { extraEnv: extra } : {}),
        ...(user !== undefined && pass !== undefined ? { account: { user, pass } } : {}),
      });
    },
  });
}
