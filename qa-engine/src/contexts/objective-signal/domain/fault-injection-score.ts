/* No side effects, no src/ import: this is the domain half of the e2e value oracle. See fault-injection-oracle.adapter.ts for the orchestration half (the browser re-run + JSON-corruption counter reads, which stay effectful and live in infrastructure/). The re-run corrupts only the responses of the operations the change reaches. A spec that STAYS GREEN while a response of such an operation is corrupted has a weak oracle for this change (it would accept a backend regression there). The score is the fraction of the specs exposed to a corrupted response that NOTICED it, per use case the change makes testable and over the run. Signal-only: never gates publish by itself. */
import type { QaCase } from "@kernel/qa-case.ts";
import type { FaultCounterRecord } from "./dump-sanitizers.ts";
import { sameSpecFile } from "./spec-match.ts";

export const FLOW_BREAK =
  /net::ERR|\bERR_[A-Z_]+|page\.goto|Target (?:closed|page, context or browser has been closed)|Execution context was destroyed|ECONNREFUSED/i;

export function isFlowBreak(c: QaCase): boolean {
  return FLOW_BREAK.test(`${c.detail ?? ""} ${c.reason ?? ""}`);
}

/* The key an operation is counted under: its verb and the pattern the seed matches, as the seed writes it in a counter. */
export const operationKey = (operation: { verb: string; pattern: string }): string => `${operation.verb.toUpperCase()} ${operation.pattern}`;

/* One use case and the operations (by key) its change reaches. */
export interface FaultAimCandidate {
  candidateId: string;
  operations: readonly string[];
}

/* What the corrupted re-run is aimed at: the operations it may corrupt, the use cases they belong to, and which spec was written or held for which use case. */
export interface FaultAim {
  operations: ReadonlyArray<{ verb: string; pattern: string }>;
  candidates: readonly FaultAimCandidate[];
  specToCandidates: ReadonlyArray<{ specFile: string; candidates: readonly string[] }>;
}

/* Why a use case has no ratio: none of its specs requested a reached operation (a finding in itself: the test does not exercise the changed operation), it has no baseline-passing spec, or the re-run cannot tell. */
export type CandidateValueUnscored = "no-operation-hit" | "no-spec" | "inconclusive";

export interface CandidateValue {
  candidateId: string;
  exposed: number;
  killed: number;
  ratio: number | null;
  unscored?: CandidateValueUnscored;
}

export interface FaultInjectionScore {
  valueScore: number | null;
  exposed: number;
  killed: number;
  perCandidate: CandidateValue[];
}

/* The title a counter names its test by is the test's own; a case's name may carry the groups above it. */
function sameTest(c: QaCase, test: string): boolean {
  const at = test.indexOf("::");
  const file = at >= 0 ? test.slice(0, at) : undefined;
  const title = at >= 0 ? test.slice(at + 2) : test;
  if (file !== undefined && c.file !== undefined && !sameSpecFile(c.file, file)) return false;
  return c.name === title || c.name.endsWith(title) || title.endsWith(c.name);
}

/*
 * A baseline-passing spec is exposed to a use case when its counter shows a corrupted response of one of the use case's
 * operations; it is killed when it then failed (or went flaky) and the failure is not the flow breaking. A use case's ratio is
 * killed over exposed; the run's score is killed over every exposed spec. A spec the re-run did not execute counts for nothing.
 */
export function scoreFaultInjection(input: { baselinePass: readonly string[]; corrupted: readonly QaCase[]; counters: readonly FaultCounterRecord[]; aim: FaultAim }): FaultInjectionScore {
  const baseline = new Set(input.baselinePass);
  const seen = new Set<string>();
  const specs = input.corrupted
    .filter((c) => baseline.has(c.name) && !seen.has(c.name) && seen.add(c.name))
    .map((c) => {
      const records = input.counters.filter((r) => r.test !== undefined && sameTest(c, r.test));
      const operations = new Set(records.flatMap((r) => Object.entries(r.byOperation ?? {}).filter(([, n]) => n > 0).map(([key]) => key)));
      const exposed = records.some((r) => r.corrupted > 0);
      const killed = exposed && (c.status === "fail" || c.status === "flaky") && !isFlowBreak(c);
      return { c, operations, exposed, killed };
    });
  const exposedRun = specs.filter((s) => s.exposed);
  const killedRun = exposedRun.filter((s) => s.killed).length;
  const perCandidate = input.aim.candidates.map((candidate): CandidateValue => {
    const empty = { candidateId: candidate.candidateId, exposed: 0, killed: 0, ratio: null };
    if (candidate.operations.length === 0) return { ...empty, unscored: "inconclusive" };
    const named = new Set(input.aim.specToCandidates.filter((m) => m.candidates.includes(candidate.candidateId)).map((m) => m.specFile));
    const held = specs.filter((s) => s.c.file !== undefined && [...named].some((file) => sameSpecFile(file, s.c.file!)));
    if (named.size === 0) return { ...empty, unscored: "no-spec" };
    if (held.length === 0) return { ...empty, unscored: "inconclusive" };
    const exposed = held.filter((s) => candidate.operations.some((key) => s.operations.has(key)));
    if (exposed.length === 0) return { ...empty, unscored: "no-operation-hit" };
    const killed = exposed.filter((s) => s.killed).length;
    return { candidateId: candidate.candidateId, exposed: exposed.length, killed, ratio: killed / exposed.length };
  });
  return { valueScore: exposedRun.length > 0 ? killedRun / exposedRun.length : null, exposed: exposedRun.length, killed: killedRun, perCandidate };
}
