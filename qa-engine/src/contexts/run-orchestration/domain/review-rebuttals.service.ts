/*
 * The generator's rebuttal, judged by the orchestrator. A rebuttal withdraws a reviewer finding only
 * when what it names can be checked against the current bytes: a case that ran green, or a contract
 * clause that is intact. A claim the orchestrator cannot check never withdraws and never becomes
 * evidence — it is a dispute, and the run reports it instead of deciding. Pure: no I/O.
 */

import { resolveSpecReference } from "@kernel/spec-path.ts";

/** What a rebuttal rests on. A free-text reason is never a basis. */
export type RebuttalBasis = "execution" | "contract";

/** One finding the generator refuses to correct, and the evidence it claims for that refusal. */
export interface ReviewRebuttal {
  /** The id of the finding it answers, as the run admitted it: a rebuttal names one finding, never every finding with the same text. */
  readonly findingId: string;
  readonly basis: RebuttalBasis;
  /** The case name or spec path (execution), or `<spec>#<clause>` (contract). */
  readonly ref: string;
  readonly reason: string;
}

/** A finding of the round a rebuttal can name: its id and, for the record, its text. */
export interface RoundFinding {
  readonly id: string;
  readonly text: string;
}

/** What the orchestrator knows about the current bytes: the only facts that can withdraw a finding. */
export interface RebuttalEvidence {
  /** Case names and spec files whose every case ran green on the current bytes. */
  readonly greenCaseRefs: ReadonlySet<string>;
  /** `<spec>#<clauseId>` clauses the current bytes still hold. */
  readonly intactClauses: ReadonlySet<string>;
  /** The spec directory under the mirror: both sets name specs suite-relative, and a rebuttal may spell the directory in front. */
  readonly specRelDir?: string;
}

/** A finding the turn disputed without evidence the orchestrator could check. */
export interface DisputedFinding {
  readonly findingId: string;
  /** The finding's text, for the record. */
  readonly finding: string;
  readonly rebuttal: ReviewRebuttal;
}

export interface VerifiedRebuttals {
  /** The ids of the findings withdrawn with evidence the orchestrator checked: they no longer block. */
  readonly withdrawn: readonly string[];
  /** Findings disputed on a claim nobody can check: the run cannot settle them. */
  readonly disputed: readonly DisputedFinding[];
  /** Rebuttals whose id names no finding of the round: unreadable, they withdraw and dispute nothing. */
  readonly unnamed: readonly ReviewRebuttal[];
}

/** A citation reference's identity: the same separators and path slashes, whatever the model wrote; whitespace and case do not make it another reference. */
export function refKey(ref: string): string {
  return ref.replace(/\s+/g, " ").trim().toLowerCase().replaceAll("\\", "/");
}

/** The key a contract rebuttal's `<spec>#<clause>` holds in `intactClauses`: the spec in its suite-relative form, whatever prefix it was spelled with. */
export function contractRefKey(ref: string, specRelDir: string): string {
  const slashed = ref.trim().replaceAll("\\", "/");
  const hash = slashed.lastIndexOf("#");
  if (hash <= 0) return refKey(ref);
  const spec = resolveSpecReference(slashed.slice(0, hash), specRelDir);
  return `${spec ?? refKey(slashed.slice(0, hash))}#${refKey(slashed.slice(hash + 1))}`;
}

/** Whether the green set holds what an execution rebuttal names: a case name, or a spec in any spelling (a reference with a clause marker names no run). */
function greenFor(ref: string, evidence: RebuttalEvidence): boolean {
  if (evidence.greenCaseRefs.has(refKey(ref))) return true;
  if (ref.includes("#")) return false;
  const spec = resolveSpecReference(ref, evidence.specRelDir ?? "");
  return spec !== undefined && evidence.greenCaseRefs.has(spec);
}

/**
 * Sort each rebuttal of this round's findings into withdrawn (the orchestrator checked what it names) and disputed (it does not).
 * A rebuttal names one finding by the id the run admitted it under; one whose id is no finding of this round is unnamed and
 * disputes nothing. A finding with any verified rebuttal is withdrawn, never also disputed.
 */
export function verifyRebuttals(
  rebuttals: readonly ReviewRebuttal[],
  findings: readonly RoundFinding[],
  evidence: RebuttalEvidence,
): VerifiedRebuttals {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const withdrawn = new Set<string>();
  const disputed = new Map<string, DisputedFinding>();
  const unnamed: ReviewRebuttal[] = [];

  for (const rebuttal of rebuttals) {
    const finding = byId.get(rebuttal.findingId);
    if (!finding) {
      unnamed.push(rebuttal);
      continue;
    }
    const checked =
      rebuttal.basis === "execution"
        ? greenFor(rebuttal.ref, evidence)
        : evidence.intactClauses.has(contractRefKey(rebuttal.ref, evidence.specRelDir ?? ""));
    if (checked) withdrawn.add(finding.id);
    else if (!disputed.has(finding.id)) disputed.set(finding.id, { findingId: finding.id, finding: finding.text, rebuttal });
  }

  return {
    withdrawn: [...withdrawn],
    disputed: [...disputed.values()].filter((entry) => !withdrawn.has(entry.findingId)),
    unnamed,
  };
}

/** A rebuttal as a turn's answer carries it: the finding's id when the lead's answer named it, else the number the author's correction turn showed it (`finding`). */
export interface AnsweredRebuttal {
  readonly finding: string;
  readonly findingId?: string;
  readonly basis: RebuttalBasis;
  readonly ref: string;
  readonly reason: string;
}

/* The number a correction turn shows a finding by: its place in the round's findings, from 1. */
const shownNumber = /^[1-9][0-9]*$/;

/**
 * The rebuttals of a turn, each naming one finding of the round by its id. A rebuttal the answer named by id is taken as it is.
 * The author names a finding by the number its correction turn showed it (`agents/agent/qa-author.md`), its place in the round's
 * findings from 1; a number the round never showed, or anything else (a repeated text), names none and is returned unread. A
 * finding is never named by its text: two findings may say the same thing about different specs.
 */
export function namedRebuttals(answered: readonly AnsweredRebuttal[], findings: readonly RoundFinding[]): { rebuttals: ReviewRebuttal[]; unread: AnsweredRebuttal[] } {
  const rebuttals: ReviewRebuttal[] = [];
  const unread: AnsweredRebuttal[] = [];
  for (const rebuttal of answered) {
    const { basis, ref, reason } = rebuttal;
    if (rebuttal.findingId !== undefined) {
      rebuttals.push({ findingId: rebuttal.findingId, basis, ref, reason });
      continue;
    }
    const shown = shownNumber.test(rebuttal.finding) ? findings[Number(rebuttal.finding) - 1] : undefined;
    if (shown) rebuttals.push({ findingId: shown.id, basis, ref, reason });
    else unread.push(rebuttal);
  }
  return { rebuttals, unread };
}
