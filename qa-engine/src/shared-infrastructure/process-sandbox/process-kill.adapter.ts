/* The ONE killTree — consolidates the 4 identical src/ definitions (execute.ts:64, code-runner.ts:64, static-signal/exec.ts:6, learning/mutation-code.ts:10). Spawns are detached so the child leads its own process group; process.kill(-pid) signals the whole group (npm/mvn/gradle/playwright fork grandchildren a plain child.kill() would orphan). Falls back to a direct kill if the group send fails (e.g. the child already exited). It also closes the parent's read side of the child's stdout/stderr: a descendant that escaped the group (its own session) still holds those pipes and would otherwise keep feeding the parent, and keep the child's `close` from ever firing. process.kill is injected so the group path is unit-testable. */

import type { ChildProcess } from "node:child_process";
import type { ProcessKillPort } from "../../shared-kernel/process-sandbox/process-kill.port.ts";

type KillFn = (pid: number, signal: NodeJS.Signals) => void;

export class ProcessKillAdapter implements ProcessKillPort {
  constructor(private readonly kill: KillFn = (pid, sig) => { process.kill(pid, sig); }) {}

  killTree(child: ChildProcess): void {
    try {
      if (child.pid) this.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}
