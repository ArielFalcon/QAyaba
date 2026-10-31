/*
 * The executions of one run's suite as the run sees them (RFC-0015): every one goes through the run's execution port, which tells it
 * when the run signed in the session it is given and keeps the conditions its runner reports, in the order they ran, for the run
 * record. One per run.
 *
 * The session is a condition of a judging execution, checked by a fact and never by its age: a judging execution of a run that
 * signed in, whose failure ended on the app's login page (`endedOnLoginWall`), judged nothing about the specs. The run signs in
 * again through its own login and runs that execution once more; a second wall, or a login that cannot be completed, is a lost
 * session (`SessionLostError`), which ends the run. A measuring execution is no judgment and is not checked.
 */

import { MAX_RECORDED_EXECUTIONS, recordOfExecution, type ExecutionRecord, type ExecutionsSignal } from "@kernel/execution-conditions.ts";
import { endedOnLoginWall, type ExecutionOpts, type ExecutionPort } from "@contexts/test-execution/application/index.ts";
import { SessionLostError } from "./failure-policy.ts";

type ExecutionResult = Awaited<ReturnType<ExecutionPort["execute"]>>;

/** Signs the run's session in again before a judging execution is run once more; false when the login could not be completed. */
export type RenewSession = (specDir: string, signal: AbortSignal | undefined) => Promise<boolean>;

export interface RunExecutions {
  /** The run signed the session in at `at` (wall-clock ms): every execution after it is told so. */
  signedIn(at: number): void;
  /** When the run last signed the session in; undefined before it did. */
  signedInAt(): number | undefined;
  /** `base` as the run's executions go through it; with `renew`, a judging execution that ended on the login wall is run once more after it. */
  port(base: ExecutionPort, renew?: RenewSession): ExecutionPort;
  /** The executions recorded so far; undefined when none reported its conditions. */
  signal(): ExecutionsSignal | undefined;
}

const optsOf = (opts: AbortSignal | ExecutionOpts | undefined): ExecutionOpts => (opts === undefined ? {} : opts instanceof AbortSignal ? { signal: opts } : opts);

/* An execution whose verdict is a judgment of the specs: every one but the measurement of passing tests. */
const judges = (opts: ExecutionOpts): boolean => opts.purpose !== "measurement" && opts.coverage !== true;

const onLoginWall = (result: ExecutionResult): boolean => result.verdict !== "pass" && endedOnLoginWall(result.cases);

export function runExecutions(): RunExecutions {
  let signedInAt: number | undefined;
  const runs: ExecutionRecord[] = [];
  let omitted = 0;
  return {
    signedIn: (at) => {
      signedInAt = at;
    },
    signedInAt: () => signedInAt,
    port: (base, renew) => {
      const run = async (specDir: string, opts: AbortSignal | ExecutionOpts | undefined): Promise<ExecutionResult> => {
        const given = optsOf(opts);
        const result = await base.execute(specDir, signedInAt !== undefined && given.session === undefined ? { ...given, session: { signedInAt } } : opts);
        if (result.conditions) {
          if (runs.length < MAX_RECORDED_EXECUTIONS) runs.push(recordOfExecution(result.conditions));
          else omitted += 1;
        }
        return result;
      };
      return {
        execute: async (specDir, opts) => {
          const given = optsOf(opts);
          const signed = signedInAt !== undefined && given.session === undefined;
          const first = await run(specDir, opts);
          if (!renew || !signed || !judges(given) || !onLoginWall(first)) return first;
          if (!(await renew(specDir, given.signal))) throw new SessionLostError(`a ${given.purpose ?? "suite"} execution ended on the login page and the run could not sign in again`);
          const second = await run(specDir, opts);
          if (onLoginWall(second)) throw new SessionLostError(`a ${given.purpose ?? "suite"} execution ended on the login page twice, the second time with a session the run had just signed in`);
          return second;
        },
      };
    },
    signal: () => (runs.length === 0 ? undefined : { runs: [...runs], ...(omitted > 0 ? { omitted } : {}) }),
  };
}
