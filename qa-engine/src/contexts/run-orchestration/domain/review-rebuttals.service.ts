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
  /** The reviewer finding it answers, as the generator received it. */
  readonly finding: string;
  readonly basis: RebuttalBasis;
  /** The case name or spec path (execution), or `<spec>#<clause>` (contract). */
  readonly ref: string;
  readonly reason: string;
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
  readonly finding: string;
  readonly rebuttal: ReviewRebuttal;
}

export interface VerifiedRebuttals {
  /** Findings withdrawn with evidence the orchestrator checked: they no longer block. */
  readonly withdrawn: readonly string[];
  /** Findings disputed on a claim nobody can check: the run cannot settle them. */
  readonly disputed: readonly DisputedFinding[];
}

/* The shortest overlap that still identifies one finding rather than a phrase the two share. */
const MIN_MATCH_CHARS = 24;

/** A finding's identity for matching: whitespace and case do not make it another finding. */
export function findingKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** A citation reference's identity: the same separators and path slashes, whatever the model wrote. */
export function refKey(ref: string): string {
  return findingKey(ref).replaceAll("\\", "/");
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

/*
 * The generator names a finding by repeating it. A repeated finding may be abridged, so a containment
 * counts once it is long enough to be specific; anything shorter is ambiguous and names nothing.
 */
function names(rebuttalFinding: string, finding: string): boolean {
  const claimed = findingKey(rebuttalFinding);
  const actual = findingKey(finding);
  if (claimed === actual) return true;
  const [shorter, longer] = [claimed, actual].sort((a, b) => a.length - b.length) as [string, string];
  return shorter.length >= MIN_MATCH_CHARS && longer.includes(shorter);
}

/**
 * Sort each rebuttal of this round's findings into withdrawn (the orchestrator checked what it names)
 * and disputed (it does not). A rebuttal that names no finding of this round disputes nothing; a
 * finding with any verified rebuttal is withdrawn, never also disputed.
 */
export function verifyRebuttals(
  rebuttals: readonly ReviewRebuttal[],
  findings: readonly string[],
  evidence: RebuttalEvidence,
): VerifiedRebuttals {
  const withdrawn = new Set<string>();
  const disputed = new Map<string, DisputedFinding>();

  for (const rebuttal of rebuttals) {
    const checked =
      rebuttal.basis === "execution"
        ? greenFor(rebuttal.ref, evidence)
        : evidence.intactClauses.has(contractRefKey(rebuttal.ref, evidence.specRelDir ?? ""));
    for (const finding of findings) {
      if (!names(rebuttal.finding, finding)) continue;
      if (checked) withdrawn.add(finding);
      else if (!disputed.has(finding)) disputed.set(finding, { finding, rebuttal });
    }
  }

  return {
    withdrawn: [...withdrawn],
    disputed: [...disputed.values()].filter((entry) => !withdrawn.has(entry.finding)),
  };
}
