/*
 * How many flows a run can author, and what each flow is granted, derived from the run's own numbers: the flows that run at once,
 * the time one flow may take and what is left of the run after the reserve. An app may set a ceiling for cost; nothing else caps the
 * count. A flow's tool grant is primary: the calls its own time can run, so the run's total is the sum of its flows' grants; an
 * app's ceiling on a total turns the grant into a share of it, never under a useful minimum. Pure: no clock, no file, no model.
 */

export interface CapacityInput {
  /* The most flows that run at once. */
  maxParallel: number;
  /* The most time one flow may take. */
  flowBudgetMs: number;
  /* What is left of the run's time; absent when the run has no deadline. */
  remainingMs?: number;
  /* What the run keeps for what follows the flows (validation, execution, the reviewer). */
  reserveMs: number;
  /* Less than this and a flow cannot read the brief, write a spec and try it once. */
  minFlowMs: number;
  /* The app's ceiling on flows, for cost; absent: none. */
  ceiling?: number;
}

/*
 * The flows the run can author: `maxParallel` x the full flow budgets that fit in what is left after the reserve, at least one wave
 * while a flow still has its minimum, bounded by the app's ceiling. 0 when no flow has its minimum. Undefined when nothing bounds it
 * (no deadline and no ceiling).
 */
export function flowCapacity(input: CapacityInput): number | undefined {
  const parallel = Math.max(1, input.maxParallel);
  const byTime = (() => {
    if (input.remainingMs === undefined) return undefined;
    const available = input.remainingMs - input.reserveMs;
    if (available < input.minFlowMs) return 0;
    return parallel * Math.max(1, Math.floor(available / input.flowBudgetMs));
  })();
  if (input.ceiling === undefined) return byTime;
  return byTime === undefined ? input.ceiling : Math.min(byTime, input.ceiling);
}

/*
 * The run_spec calls a flow is granted at least out of an app's ceiling, when the ceiling allows that many: write the spec and run it, correct it once, and
 * run the corrected bytes to see them pass. Fewer and a flow cannot close its own loop.
 */
export const MIN_RUN_SPEC_CALLS_PER_FLOW = 3;
/* The requests that write to DEV a flow's specs may send at least, when the run's DEV-write cap allows that many: one per run of a spec that submits a form, for the run that fails and the run that passes. */
export const MIN_RUN_SPEC_DEV_WRITES_PER_FLOW = 2;
/*
 * The authenticated browser calls a flow is granted at least out of an app's ceiling, when the ceiling allows that many: open and read each page the flow
 * visits, and drive one form through it (navigate, snapshot, a few clicks and types, the snapshot after).
 */
export const MIN_BROWSER_CALLS_PER_FLOW = 20;

export interface GrantInput {
  /* Whether the run holds the tool at all. */
  held: boolean;
  /* A ceiling on the run's total of the tool, which the flows then share; absent: the run's total is the sum of the flows' grants. */
  ceiling?: number;
  /* The flows that share a ceiling. */
  flows: number;
  /* The useful minimum a flow is granted out of a ceiling, never above it. */
  minimum: number;
  /* The flow's own time and the longest one call may take: a flow is granted no more calls than its time can run. Absent: no such bound. */
  flowBudgetMs?: number;
  perCallMs?: number;
}

/*
 * What one flow is granted of a run's tool: 0 when the run does not hold it. The flow's grant is primary: with no ceiling it is the
 * calls the flow's own time can run (the minimum when nothing bounds the time), and the run's total is the sum of its flows'. With a
 * ceiling it is the flow's share of it, never under the minimum the ceiling allows; never over what the flow's time can run (at
 * least one call).
 */
export function perFlowGrant(input: GrantInput): number {
  if (!input.held) return 0;
  const byTime = input.flowBudgetMs !== undefined && input.perCallMs !== undefined && input.perCallMs > 0 ? Math.max(1, Math.floor(input.flowBudgetMs / input.perCallMs)) : undefined;
  if (input.ceiling === undefined) return byTime ?? input.minimum;
  if (input.ceiling <= 0) return 0;
  const shared = Math.max(Math.floor(input.ceiling / Math.max(1, input.flows)), Math.min(input.ceiling, input.minimum));
  return byTime === undefined ? shared : Math.min(shared, byTime);
}
