/*
 * The executions of one run's suite as the run sees them (RFC-0015): every one goes through the run's execution port (the verdict's,
 * the fix loop's, the acceptances', the measurement, a mutant's re-run and the unmutated observations), which tells it when the run
 * signed in the session it is given and keeps the conditions its runner reports, in the order they ran, for the run record. One per run.
 *
 * The session is a condition of a judging execution, and whether the app still accepts it is a fact the orchestrator takes itself: a
 * failure page that looks like a login page (`endedOnLoginWall`) only asks the question, never answers it. Only a run that holds a
 * saved session (its login signed one in) asks it: an app with no login, or one signed in by a client certificate, has no session to
 * lose. The check opens the pages the failing tests asked for with the session the execution was given (`SessionGuard.check`).
 * Shown lost: the run signs in again through its own login and runs that execution once more, and the re-run, under a valid session,
 * is that execution's judgment (both are recorded). Not shown lost: the first result stands and is judged as it ran. A renewal whose
 * login fails ends the run as its login before execute would (`LoginRenewalError`). A re-run that meets the login page again, with
 * the check showing the session it was just given gone again, is a lost session (`SessionLostError`): the app (or a spec that signs
 * out) ends every session within one execution, and neither execution judged the specs. A measuring execution is no judgment and is
 * never checked.
 *
 * Only an execution that judges the verdict (the verdict's, a fix-loop round or its triage, an acceptance, the enforce re-measure's
 * judging run: purpose `suite`, `fix-retry` or `acceptance`) ends the run on a lost session. A signal execution that judges a spec
 * for a signal only (a mutant's re-run, in the mutation pass, the enforce re-measure's pass or the survivor closure) is renewed and
 * re-run the same way, but when its session is still gone, or could not be renewed, its result comes back `notJudged: session-lost`:
 * the oracle counts it apart and judges nothing from it, and the run goes on (bundle mutation is a signal, never a gate). The next
 * execution that judges the verdict meets the session as it is and decides.
 */

import { kindOfPurpose, MAX_RECORDED_EXECUTIONS, recordOfExecution, type ExecutionRecord, type ExecutionsSignal } from "@kernel/execution-conditions.ts";
import { purposeOfExecution, type ExecPurpose } from "@kernel/exec-purpose.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { engineLog } from "@kernel/ports/process-logger.ts";
import { endedOnLoginWall, type ExecutionOpts, type ExecutionPort, type SessionCheck } from "@contexts/test-execution/application/index.ts";
import { LoginRenewalError, SESSION_LOST, SessionLostError } from "./failure-policy.ts";

type ExecutionResult = Awaited<ReturnType<ExecutionPort["execute"]>>;

/** What the run's own login answered when asked to renew the session: signed in, or the note of why it could not. */
export type SessionRenewal = { renewed: true } | { failed: string; preconditionFailed: boolean };

/** The run's own check of its session and its own renewal of it, as the executions' guard uses them. */
export interface SessionGuard {
  /** Whether the session the execution was given is still one the app accepts, judged on the pages the failing `cases` asked for. */
  check(specDir: string, cases: readonly QaCase[], signal: AbortSignal | undefined): Promise<SessionCheck>;
  /** Signs the run's session in again, through the run's own login. */
  renew(specDir: string, signal: AbortSignal | undefined): Promise<SessionRenewal>;
}

export interface RunExecutions {
  /** The run signed a session it can lose in at `at` (wall-clock ms): every execution after it is told so, and a judging one is guarded. */
  signedIn(at: number): void;
  /** When the run last signed the session in; undefined before it did, and always for a run that holds no saved session. */
  signedInAt(): number | undefined;
  /** `base` as the run's executions go through it; with `guard`, a judging execution whose failures look like the login page asks whether the session is gone. */
  port(base: ExecutionPort, guard?: SessionGuard): ExecutionPort;
  /** The executions recorded so far and the checks of the session they asked for; undefined when none reported its conditions and none asked. */
  signal(): ExecutionsSignal | undefined;
}

const optsOf = (opts: AbortSignal | ExecutionOpts | undefined): ExecutionOpts => (opts === undefined ? {} : opts instanceof AbortSignal ? { signal: opts } : opts);

/* An execution whose outcome is a judgment of the specs, by what it is for: the verdict's, the fix loop's, an acceptance, a mutant's re-run. */
const judges = (opts: ExecutionOpts): boolean => kindOfPurpose(purposeOfExecution(opts)) === "judging";

/* The purposes whose outcome is the verdict or decides what the verdict is made of: only they may end the run on a lost session. */
const VERDICT_PURPOSES: ReadonlySet<ExecPurpose> = new Set(["suite", "fix-retry", "acceptance"]);
const judgesVerdict = (opts: ExecutionOpts): boolean => VERDICT_PURPOSES.has(purposeOfExecution(opts));

/* The failed cases that look like the login page: the question, never the answer. */
const wallCases = (result: ExecutionResult): QaCase[] => (result.verdict === "pass" ? [] : result.cases.filter((c) => endedOnLoginWall([c])));

/** What the run tells its executions' record: the DEV writes it has counted so far (its run_spec calls'), undefined when it counts none. */
export interface RunExecutionsDeps {
  devWrites?: () => number | undefined;
}

export function runExecutions(deps: RunExecutionsDeps = {}): RunExecutions {
  let signedInAt: number | undefined;
  const runs: ExecutionRecord[] = [];
  let omitted = 0;
  const checks = { lost: 0, held: 0, unknown: 0 };
  return {
    signedIn: (at) => {
      signedInAt = at;
    },
    signedInAt: () => signedInAt,
    port: (base, guard) => {
      const run = async (specDir: string, opts: AbortSignal | ExecutionOpts | undefined): Promise<ExecutionResult> => {
        const given = optsOf(opts);
        const devWritesBefore = deps.devWrites?.();
        const result = await base.execute(specDir, signedInAt !== undefined && given.session === undefined ? { ...given, session: { signedInAt } } : opts);
        if (result.conditions) {
          if (runs.length < MAX_RECORDED_EXECUTIONS) runs.push(recordOfExecution(result.conditions, devWritesBefore !== undefined ? { devWritesBefore } : {}));
          else omitted += 1;
        }
        return result;
      };
      /* Asks the guard whether the session of `result` is gone, when its failures look like the login page; counted, and said when it is. */
      const lostIn = async (specDir: string, given: ExecutionOpts, result: ExecutionResult): Promise<SessionCheck | undefined> => {
        const wall = wallCases(result);
        if (wall.length === 0) return undefined;
        const checked = await guard!.check(specDir, wall, given.signal);
        checks[checked.state] += 1;
        const what = `a ${purposeOfExecution(given)} execution failed on a page that looks like the login page`;
        if (checked.state === "lost") engineLog.warn(`[qa] ${what}, and the session it was given is gone (${checked.detail})`);
        else engineLog.info(`[qa] ${what}; the session it was given was ${checked.state === "held" ? "still accepted" : `not checked (${checked.reason})`}, so its result stands`);
        return checked;
      };
      return {
        execute: async (specDir, opts) => {
          const given = optsOf(opts);
          const guarded = guard !== undefined && signedInAt !== undefined && given.session === undefined && judges(given);
          const first = await run(specDir, opts);
          if (!guarded || !guard || (await lostIn(specDir, given, first))?.state !== "lost") return first;
          /* A signal execution whose session stays gone is not judged; only one that judges the verdict ends the run. */
          const notJudged = (result: ExecutionResult, why: string): ExecutionResult => {
            engineLog.warn(`[qa] a ${purposeOfExecution(given)} execution is not judged: ${why}; the run goes on, and the next execution that judges the verdict meets the session as it is`);
            return { ...result, notJudged: SESSION_LOST };
          };
          const renewed = await guard.renew(specDir, given.signal);
          if ("failed" in renewed) {
            if (judgesVerdict(given)) throw new LoginRenewalError(renewed.failed, renewed.preconditionFailed);
            return notJudged(first, `the run's login could not renew the session it lost (${renewed.failed})`);
          }
          const second = await run(specDir, opts);
          if ((await lostIn(specDir, given, second))?.state === "lost") {
            const why = `a ${purposeOfExecution(given)} execution met the login page twice, and the session the run had just signed in for the second was gone again`;
            if (judgesVerdict(given)) throw new SessionLostError(why);
            return notJudged(second, "the session the run had just signed in for its re-run was gone again");
          }
          return second;
        },
      };
    },
    signal: () => {
      const checked = checks.lost + checks.held + checks.unknown;
      if (runs.length === 0 && checked === 0) return undefined;
      return { runs: [...runs], ...(omitted > 0 ? { omitted } : {}), ...(checked > 0 ? { sessionChecks: { ...checks } } : {}) };
    },
  };
}
