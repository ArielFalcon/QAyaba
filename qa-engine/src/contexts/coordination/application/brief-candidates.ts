/*
 * The use cases a flow's brief carries: the ones its plan cites, then the ones its routes name, each with the symbols and hunks of the
 * change that reach it and where the expected behavior comes from. Bounded; the brief's constructor redacts every text. Pure.
 */
import { entryKey } from "@kernel/change-reach.ts";
import { hunksFor } from "@kernel/diff-parser/hunks-for.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { BriefCandidate, ExpectedSource } from "./delegation-brief.ts";
import { boundedSteps } from "./change-proofs.ts";
import { flowCovers, type PlannedFlow } from "./plan-coverage.ts";

export const MAX_BRIEF_CANDIDATES = 4;
export const MAX_BRIEF_SYMBOLS = 8;

/* What the run knows of the change besides the candidates: its diffs (one per repo of the change) and the anchor commit's subject. */
export interface ChangeFacts {
  diffs: readonly string[];
  subject?: string;
}

/* The expected behavior's sources, most specific first and always ending with the diff: a declared contract operation, the commit's stated intent, the changed code. */
function expectedFrom(candidate: UseCaseCandidate, facts: ChangeFacts): ExpectedSource[] {
  const sources: ExpectedSource[] = [];
  if (candidate.entry.kind === "operation" && (candidate.basis === "contract" || candidate.entry.operationId !== undefined)) sources.push({ kind: "contract", ref: entryKey(candidate.entry) });
  if (facts.subject !== undefined && facts.subject.trim() !== "") sources.push({ kind: "commit-message", ref: facts.subject.trim() });
  sources.push({ kind: "diff", ref: [...new Set(candidate.seeds.map((seed) => seed.file))].join(", ") || entryKey(candidate.entry) });
  return sources;
}

function briefCandidateOf(candidate: UseCaseCandidate, facts: ChangeFacts): BriefCandidate {
  const symbols = [...new Set(candidate.seeds.map((seed) => (seed.range ? `${seed.symbol} (${seed.file}:${seed.range.start}-${seed.range.end})` : `${seed.symbol} (${seed.file})`)))].slice(0, MAX_BRIEF_SYMBOLS);
  const hunks = [...new Set(facts.diffs.flatMap((diff) => hunksFor(diff, candidate.seeds)))].slice(0, 3);
  return { id: candidate.id, entry: entryKey(candidate.entry), tier: candidate.tier, evidence: boundedSteps(candidate.evidence), symbols, hunks, expectedFrom: expectedFrom(candidate, facts) };
}

export function briefCandidatesFor(flow: PlannedFlow, candidates: readonly UseCaseCandidate[] | undefined, facts: ChangeFacts): BriefCandidate[] {
  const all = candidates ?? [];
  const cited = flow.candidates.flatMap((id) => all.filter((c) => c.id === id));
  const named = all.filter((c) => !flow.candidates.includes(c.id) && flowCovers({ routes: flow.routes, candidates: [] }, c));
  return [...new Set([...cited, ...named])].slice(0, MAX_BRIEF_CANDIDATES).map((c) => briefCandidateOf(c, facts));
}
