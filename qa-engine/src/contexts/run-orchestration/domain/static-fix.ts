/*
 * Whether the static gate's failure is worth another repair round. Pure: no I/O, no clock; the step that runs a round asks this
 * with the counter and the evidence and does what it answers.
 */

export type StaticFixAction = "repair" | "stop";

export interface StaticFixInput {
  /** The gate's last verdict: `infra` means the gate itself could not run, which no repair of the specs changes. */
  validation: { ok: boolean; infra?: boolean | undefined };
  /** Repair rounds spent so far. */
  rounds: number;
  /** The most rounds a run may spend. */
  max: number;
  /** Every delivered spec was seen passing in the run_spec loop: a failing gate then ends the run instead of rewriting a spec the generator saw pass. */
  retired: boolean;
  /** Only a run that authors tests repairs them. */
  generating: boolean;
  /** There is something to repair: specs delivered, or reported by the last generation. */
  hasDelivered: boolean;
}

export function staticFixAction(input: StaticFixInput): StaticFixAction {
  const { validation, rounds, max, retired, generating, hasDelivered } = input;
  return !retired && !validation.ok && !validation.infra && generating && hasDelivered && rounds < max ? "repair" : "stop";
}
