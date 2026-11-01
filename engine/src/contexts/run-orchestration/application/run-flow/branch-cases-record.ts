import type { UntakenArm, UntakenDecision } from "@contexts/objective-signal/application/index.ts";
import type { FindingPlacement } from "@kernel/finding-placement.ts";
import type { DropBasis } from "@kernel/drop-basis.ts";
import type { BranchCasesDecision, BranchCasesRecord } from "@kernel/run-outcome.ts";

type Recorded = Pick<BranchCasesRecord, "findings" | "armsTaken" | "maxFlowShare" | "survivors" | "decisions">;

/* A decision the lead declined: its identity and the basis it gave; `contradicted` when the run's facts contradicted the basis. */
export interface DeclinedDecision {
  file: string;
  line: number;
  column: number;
  kind: string;
  basis: DropBasis;
  contradicted?: true;
}

const declinedOf = (placement: FindingPlacement | undefined): BranchCasesDecision["declined"] =>
  placement?.declined ? { basis: placement.declined.basis, ...(placement.declined.contradicted !== undefined ? { contradicted: true as const } : {}) } : undefined;

/** The decisions of `units` the lead declined, from what the pass did with each finding in their order. */
export function declinedDecisionsOf(units: ReadonlyArray<{ decision?: UntakenDecision }>, placements: readonly FindingPlacement[] | undefined): DeclinedDecision[] {
  return units.flatMap(({ decision }, i) => {
    const declined = declinedOf(placements?.[i]);
    return decision && declined ? [{ file: decision.file, line: decision.line, column: decision.column, kind: decision.kind, ...declined }] : [];
  });
}

const armKey = ({ file, line, column, kind, arm }: UntakenArm): string => `${file}:${line}:${column}:${kind}:${arm}`;

/**
 * What the branch-cases regeneration records of what it was sent: `units` are the gap's units in the order they were sent as findings
 * (those about a decision carry it), `placements` what the pass did with each finding in that order (the survivors' findings follow the
 * units), `before` the arms no test ran when it was sent and `after` those the recount left, undefined when an accepted turn could not
 * be recounted. An arm is taken when its identity (file, line, column, kind and label) is in `before` and not in `after`.
 */
export function branchCasesRecord({ before, after, units, placements }: { before: readonly UntakenArm[]; after: readonly UntakenArm[] | undefined; units: ReadonlyArray<{ decision?: UntakenDecision }>; placements: readonly FindingPlacement[] | undefined }): Recorded {
  const untakenAfter = after ? new Set(after.map(armKey)) : undefined;
  const takenOf = (decision: UntakenDecision): number | undefined =>
    untakenAfter ? decision.arms.filter((arm) => !untakenAfter.has(armKey({ ...decision, arm }))).length : undefined;
  const decisions = units.flatMap((unit, i) => {
    const { decision } = unit;
    if (!decision) return [];
    const placement = placements?.[i];
    const taken = takenOf(decision);
    const declined = declinedOf(placement);
    return [{
      file: decision.file,
      line: decision.line,
      column: decision.column,
      kind: decision.kind,
      arms: decision.arms.length,
      ...(placement?.flowId !== undefined ? { flow: placement.flowId } : {}),
      ...(placement?.by !== undefined ? { by: placement.by } : {}),
      ...(taken !== undefined ? { taken } : {}),
      ...(declined ? { declined } : {}),
    }];
  });
  const perFlow = new Map<string, number>();
  for (const placement of (placements ?? []).slice(0, units.length)) if (placement.flowId !== undefined) perFlow.set(placement.flowId, (perFlow.get(placement.flowId) ?? 0) + 1);
  const survivors = (placements ?? []).slice(units.length);
  const routed = survivors.filter((placement) => placement.flowId !== undefined).length;
  return {
    findings: units.length,
    ...(untakenAfter ? { armsTaken: before.filter((arm) => !untakenAfter.has(armKey(arm))).length } : {}),
    ...(perFlow.size > 0 ? { maxFlowShare: Math.max(...perFlow.values()) / units.length } : {}),
    ...(placements && survivors.length > 0 ? { survivors: { routed, unrouted: survivors.length - routed } } : {}),
    decisions,
  };
}
