/*
 * What a Playwright child is run for, named by the call that starts it, so the trace tells apart children the command class cannot
 * (all of them are `playwright-test`): `suite` (a whole-suite execution or a re-run of some of its spec files), `acceptance` (the run
 * of a regeneration's answer, to accept or refuse it), `fix-retry` (a fix-loop round), `run-spec` (one run_spec call of an author),
 * `control` (the page load measured before a counted run's spec code), `mutant` (a bundle mutant's re-run), `observation` (the
 * unmutated runs a survivor is compared with) and `cleanup` (the orphan-data pass). Pure vocabulary.
 */

export const EXEC_PURPOSES = ["suite", "acceptance", "fix-retry", "run-spec", "control", "mutant", "observation", "cleanup"] as const;
export type ExecPurpose = (typeof EXEC_PURPOSES)[number];

/* Whether a mutant selection edits a script. The unmutated runs a survivor is compared with carry the selection of the tests to run and an edit that names no script (an empty address: no response has one), so they are no mutant's re-run; a selection that cannot be read is taken for a mutant's. */
function namesScript(mutant: unknown): boolean {
  if (typeof mutant !== "string") return true;
  try {
    const parsed: unknown = JSON.parse(mutant);
    const url = typeof parsed === "object" && parsed !== null ? (parsed as { url?: unknown }).url : undefined;
    return typeof url === "string" && url !== "";
  } catch {
    return true;
  }
}

/* What an execution is for when its caller does not say: the shape of the request tells (a mutant that edits a script, an observation, a counted run_spec, the cleanup pass), and anything else is the suite. */
export function purposeOfExecution(request: { purpose?: ExecPurpose; mutant?: unknown; observe?: boolean; countWrites?: boolean; cleanupPass?: boolean }): ExecPurpose {
  if (request.purpose) return request.purpose;
  if (request.cleanupPass) return "cleanup";
  if (request.mutant !== undefined && namesScript(request.mutant)) return "mutant";
  if (request.observe) return "observation";
  if (request.countWrites) return "run-spec";
  return "suite";
}
