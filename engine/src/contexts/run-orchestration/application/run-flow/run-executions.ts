/*
 * The executions of one run's suite as the run sees them (RFC-0015): every one goes through the run's execution port (the verdict's,
 * the fix loop's, the acceptances', the measurement, a mutant's re-run and the unmutated observations), which tells it when the run
 * signed in the session it is given and keeps the conditions its runner reports, in the order they ran, with the DEV writes the run
 * had counted when it started, for the run record. One per run; nothing here decides anything.
 *
 * The session is a recorded condition, never acted on: an execution after a login that left a saved session is told when that login
 * happened, and its age at the start is on its span and in `gateSignals.executions` (ADR-0023 row 8, amended). An app with no login,
 * or one signed in by a client certificate, holds no session whose age means anything, and its executions are told of none.
 */

import { MAX_RECORDED_EXECUTIONS, recordOfExecution, type ExecutionRecord, type ExecutionsSignal } from "@kernel/execution-conditions.ts";
import type { ExecutionOpts, ExecutionPort } from "@contexts/test-execution/application/index.ts";

import type { ForwardsAll } from "@kernel/forwarding.ts";
export interface RunExecutions {
  /** The run signed a saved session in at `at` (wall-clock ms): every execution after it is told so, and records its age. */
  signedIn(at: number): void;
  /** When the run last signed the session in; undefined before it did, and always for a run that holds no saved session. */
  signedInAt(): number | undefined;
  /** `base` as the run's executions go through it. */
  port(base: ExecutionPort): ExecutionPort;
  /** The executions recorded so far; undefined when none reported its conditions. */
  signal(): ExecutionsSignal | undefined;
}

const optsOf = (opts: AbortSignal | ExecutionOpts | undefined): ExecutionOpts => (opts === undefined ? {} : opts instanceof AbortSignal ? { signal: opts } : opts);

/** What the run tells its executions' record: the DEV writes it has counted so far (its run_spec calls'), undefined when it counts none. */
export interface RunExecutionsDeps {
  devWrites?: () => number | undefined;
}

export function runExecutions(deps: RunExecutionsDeps = {}): RunExecutions {
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
        const devWritesBefore = deps.devWrites?.();
        const result = await base.execute(specDir, signedInAt !== undefined && given.session === undefined ? { ...given, session: { signedInAt } } : opts);
        if (result.conditions) {
          if (runs.length < MAX_RECORDED_EXECUTIONS) runs.push(recordOfExecution(result.conditions, devWritesBefore !== undefined ? { devWritesBefore } : {}));
          else omitted += 1;
        }
        return result;
      },
    } satisfies ForwardsAll<ExecutionPort>),
    signal: () => (runs.length === 0 ? undefined : { runs: [...runs], ...(omitted > 0 ? { omitted } : {}) }),
  };
}
