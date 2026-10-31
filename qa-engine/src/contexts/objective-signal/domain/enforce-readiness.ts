/*
 * When an app can move to change-coverage `enforce` (ADR-0005): three consecutive replicates of one campaign case, at one qayaba
 * commit, each with a trustworthy measurement and bundle mutation on. A replicate that fails the trust test, or a replicate at
 * another commit, restarts the count. Pure: it reads only facts the run recorded (`gateSignals`), invents no reason, and moves no
 * app; moving an app stays the owner's act on its configuration.
 */

import type { RunOutcome } from "@kernel/run-outcome.ts";
import { isReadTrouble } from "./dump-outcome.ts";

export const REQUIRED_CONSECUTIVE_REPLICATES = 3;

/* The facts of a run's outcome the trust test reads. */
export type ReplicateSignals = Pick<RunOutcome["gateSignals"], "coverageRatio"> & Partial<Pick<RunOutcome["gateSignals"], "changeCoverage" | "coverage" | "bundleMutation">>;

export interface Replicate {
  runId: string;
  app: string;
  /* The campaign case the replicate repeats: one input. Replicates of different cases are never added up. */
  caseKey: string;
  /* The qayaba commit that ran it (the run's engine version); null when the run recorded none. */
  engineVersion: string | null;
  /* Null when the run saved no outcome. */
  gateSignals: ReplicateSignals | null;
}

/*
 * Why a replicate's measurement cannot be trusted, one reason per recorded fact:
 * no-outcome (the run saved none), no-engine-version (it cannot be placed on a commit), not-measured (no ratio, and the evidence
 * was not what failed: no source maps, no changed lines ...), evidence-unreadable (no ratio because the dumps could not be read),
 * stale (the ratio predates the bytes an accepted regeneration wrote), evidence-left-out (a ratio that stands without evidence a
 * read failed to give), mutants-unreadable (mutants not judged because their counters could not be read), no-bundle-mutation
 * (the mutation pass recorded nothing).
 */
export type UntrustedReason = "no-outcome" | "no-engine-version" | "not-measured" | "evidence-unreadable" | "stale" | "evidence-left-out" | "mutants-unreadable" | "no-bundle-mutation";

export function untrustedReasons(replicate: Replicate): UntrustedReason[] {
  const reasons: UntrustedReason[] = [];
  const signals = replicate.gateSignals;
  if (replicate.engineVersion === null) reasons.push("no-engine-version");
  if (signals === null) return ["no-outcome", ...reasons];
  if (signals.coverageRatio === null) {
    const unmeasured = signals.changeCoverage?.unmeasured;
    reasons.push(unmeasured !== undefined && isReadTrouble(unmeasured) ? "evidence-unreadable" : "not-measured");
  }
  if (signals.coverage?.stale === true) reasons.push("stale");
  if ((signals.changeCoverage?.evidenceLeftOut?.length ?? 0) > 0) reasons.push("evidence-left-out");
  if (signals.bundleMutation === undefined) reasons.push("no-bundle-mutation");
  else if ((signals.bundleMutation.unreadable ?? 0) > 0) reasons.push("mutants-unreadable");
  return reasons;
}

export interface CaseReadiness {
  caseKey: string;
  /* The commit of the case's latest replicate: the only one the run of trust counts. */
  engineVersion: string | null;
  replicates: number;
  /* The trustworthy replicates in a row ending at the latest one, all at `engineVersion`; 0 when the latest is not trustworthy. */
  consecutive: number;
  qualifies: boolean;
  /* The latest replicate and why it cannot be trusted; absent when it can. */
  last?: { runId: string; reasons: UntrustedReason[] };
}

export interface AppReadiness {
  app: string;
  /* True when any one case qualifies. */
  qualifies: boolean;
  cases: CaseReadiness[];
}

function caseReadiness(caseKey: string, replicates: readonly Replicate[]): CaseReadiness {
  const latest = replicates[replicates.length - 1]!;
  let consecutive = 0;
  for (let i = replicates.length - 1; i >= 0; i--) {
    const each = replicates[i]!;
    if (each.engineVersion !== latest.engineVersion || untrustedReasons(each).length > 0) break;
    consecutive++;
  }
  const lastReasons = untrustedReasons(latest);
  return {
    caseKey,
    engineVersion: latest.engineVersion,
    replicates: replicates.length,
    consecutive,
    qualifies: consecutive >= REQUIRED_CONSECUTIVE_REPLICATES,
    ...(lastReasons.length > 0 ? { last: { runId: latest.runId, reasons: lastReasons } } : {}),
  };
}

/* Answers per app, in app order, from replicates given oldest first. Cases keep the order they first appear in. */
export function enforceReadiness(replicates: readonly Replicate[]): AppReadiness[] {
  const apps = new Map<string, Map<string, Replicate[]>>();
  for (const each of replicates) {
    const cases = apps.get(each.app) ?? new Map<string, Replicate[]>();
    cases.set(each.caseKey, [...(cases.get(each.caseKey) ?? []), each]);
    apps.set(each.app, cases);
  }
  return [...apps.keys()].sort().map((app) => {
    const cases = [...apps.get(app)!].map(([caseKey, own]) => caseReadiness(caseKey, own));
    return { app, qualifies: cases.some((c) => c.qualifies), cases };
  });
}
