/*
 * Why a use case needs no test, from a closed set the orchestrator holds to its facts, and the rule each reason carries. The
 * rules are the one statement of what a basis requires: the plan turn prints them, and the refusal of a drop answers in the
 * same words. Pure.
 */

import { changedCodeOf } from "./change-map.ts";
import { isChangedCode } from "./file-classes.ts";
import type { UseCaseCandidate } from "./use-case-candidate.ts";

export const DROP_BASIS = {
  NO_OBSERVABLE_CHANGE: "no-observable-change",
  ALREADY_COVERED: "already-covered",
  NEEDS_UNAVAILABLE_STATE: "needs-unavailable-state",
} as const;
export type DropBasis = (typeof DROP_BASIS)[keyof typeof DROP_BASIS];
export const DROP_BASES: ReadonlySet<string> = new Set(Object.values(DROP_BASIS));

export interface DropBasisRule {
  /* What the lead asserts by giving the basis. */
  meaning: string;
  /* The fact of the orchestrator's that contradicts the basis, as a clause after "refuses it when"; absent when the basis names a state the orchestrator cannot see. */
  refusedWhen?: string;
}

export const DROP_BASIS_RULES: Readonly<Record<DropBasis, DropBasisRule>> = {
  [DROP_BASIS.NO_OBSERVABLE_CHANGE]: {
    meaning: "the change leaves nothing a browser can observe",
    refusedWhen: "its changed code is executable code, which a browser can observe",
  },
  [DROP_BASIS.ALREADY_COVERED]: {
    meaning: "a spec of the suite that the use case lists proves it",
    refusedWhen: "no spec of the suite is linked to it",
  },
  [DROP_BASIS.NEEDS_UNAVAILABLE_STATE]: {
    meaning: "it needs a state or a capability this run cannot reach; a state that needs only a response DEV does not return is a flow whose acceptance names it",
  },
};

/* A route the change governs that the run's own capture saw sent away: its changed behaviour was observed, and it needs no state the run lacks. */
export const GOVERNED_ROUTE_RULE: { bases: readonly DropBasis[]; refusedWhen: string } = {
  bases: [DROP_BASIS.NO_OBSERVABLE_CHANGE, DROP_BASIS.NEEDS_UNAVAILABLE_STATE],
  refusedWhen: "the run observed this route's changed behaviour with its own client",
};

const MAX_NAMED_FILES = 3;

/*
 * Why the facts the orchestrator holds contradict a drop's basis, or undefined when they do not. `no-observable-change` is refused
 * when a seed of the candidate, or a shared seed (changed code a hub carries to its page), is executable code; `already-covered`
 * when no spec of the suite is linked to the candidate; `needs-unavailable-state` names a state the orchestrator cannot see, so it stands.
 */
export function dropRefusal(candidate: UseCaseCandidate, basis: DropBasis): string | undefined {
  if (candidate.basis === "route-config" && GOVERNED_ROUTE_RULE.bases.includes(basis)) {
    return `${GOVERNED_ROUTE_RULE.refusedWhen} (${candidate.evidence[0] ?? "the change governs where it sends the browser"})`;
  }
  if (basis === DROP_BASIS.NO_OBSERVABLE_CHANGE) {
    const code = changedCodeOf(candidate).map((entry) => entry.file).filter(isChangedCode);
    return code.length > 0 ? `${DROP_BASIS_RULES[basis].refusedWhen} (${code.slice(0, MAX_NAMED_FILES).join(", ")})` : undefined;
  }
  if (basis === DROP_BASIS.ALREADY_COVERED) return candidate.existingSpecs.length === 0 ? DROP_BASIS_RULES[basis].refusedWhen : undefined;
  return undefined;
}

/* The bases a drop of the candidate is refused as: what `dropRefusal` says for each. */
export function refusedDropBasesOf(candidate: UseCaseCandidate): DropBasis[] {
  return Object.values(DROP_BASIS).filter((basis) => dropRefusal(candidate, basis) !== undefined);
}
