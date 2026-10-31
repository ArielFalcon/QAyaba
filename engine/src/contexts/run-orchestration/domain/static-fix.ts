/*
 * Whether the static gate's failure is worth another repair round. Pure: no I/O, no clock; the step that runs a round asks this
 * with the counter and the evidence and does what it answers. The run_spec loop has no say here: a call proves a spec runs against
 * DEV, never that it passes the type check, the lint or the test listing, so a spec the generator saw pass is repaired like any other.
 */

export type StaticFixAction = "repair" | "stop";

export interface StaticFixInput {
  /** The gate's last verdict: `infra` means the gate itself could not run, which no repair of the specs changes. */
  validation: { ok: boolean; infra?: boolean | undefined };
  /** Repair rounds spent so far. */
  rounds: number;
  /** The most rounds a run may spend. */
  max: number;
  /** Only a run that authors tests repairs them. */
  generating: boolean;
  /** There is something to repair: specs delivered, or reported by the last generation. */
  hasDelivered: boolean;
}

export function staticFixAction(input: StaticFixInput): StaticFixAction {
  const { validation, rounds, max, generating, hasDelivered } = input;
  return !validation.ok && !validation.infra && generating && hasDelivered && rounds < max ? "repair" : "stop";
}
