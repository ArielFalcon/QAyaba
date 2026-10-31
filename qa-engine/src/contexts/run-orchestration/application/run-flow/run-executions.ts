/*
 * The executions of one run's suite as the run sees them (RFC-0015): every one goes through the run's execution port, which tells it
 * when the run signed in the session it is given and keeps the conditions its runner reports, in the order they ran, for the run
 * record. One per run; nothing here decides anything.
 */

import { MAX_RECORDED_EXECUTIONS, recordOfExecution, type ExecutionRecord, type ExecutionsSignal } from "@kernel/execution-conditions.ts";
import type { ExecutionOpts, ExecutionPort } from "@contexts/test-execution/application/index.ts";

export interface RunExecutions {
  /** The run signed the session in at `at` (wall-clock ms): every execution after it is told so. */
  signedIn(at: number): void;
  /** When the run last signed the session in; undefined before it did. */
  signedInAt(): number | undefined;
  /** `base` as the run's executions go through it. */
  port(base: ExecutionPort): ExecutionPort;
  /** The executions recorded so far; undefined when none reported its conditions. */
  signal(): ExecutionsSignal | undefined;
}

const optsOf = (opts: AbortSignal | ExecutionOpts | undefined): ExecutionOpts => (opts === undefined ? {} : opts instanceof AbortSignal ? { signal: opts } : opts);

export function runExecutions(): RunExecutions {
  let signedInAt: number | undefined;
  const runs: ExecutionRecord[] = [];
  let omitted = 0;
  return {
    signedIn: (at) => {
      signedInAt = at;
    },
    signedInAt: () => signedInAt,
    port: (base) => ({
      execute: async (specDir, opts) => {
        const given = optsOf(opts);
        const result = await base.execute(specDir, signedInAt !== undefined && given.session === undefined ? { ...given, session: { signedInAt } } : opts);
        if (result.conditions) {
          if (runs.length < MAX_RECORDED_EXECUTIONS) runs.push(recordOfExecution(result.conditions));
          else omitted += 1;
        }
        return result;
      },
    }),
    signal: () => (runs.length === 0 ? undefined : { runs: [...runs], ...(omitted > 0 ? { omitted } : {}) }),
  };
}
