/*
 * The change a flow's brief carries, cut from the run's change map: the use cases the flow must exercise (the ones its plan cites,
 * then the ones its routes name), each with its reach path, its changed symbols and where its expected behavior comes from; the
 * files its candidates seed, with kind, added lines and how each was linked to them; and the slice's owned hunks, ranked code first,
 * then by the decision rank, then in diff order, never cut. What the brief does not preload is named by file and range. Whether the
 * brief preloads every owned hunk is the fit rule's to say (`fitBriefChange`), never a fixed count. Pure; the brief's constructor
 * redacts every text.
 */
import { buildChangeMap } from "@kernel/change-map.ts";
import { sliceFor, type ChangeSlice, type HunkReference, type SliceOptions } from "@kernel/change-slice.ts";
import { classifyPath, FILE_CLASS_ORDER } from "@kernel/file-classes.ts";
import { hunkLineCounts } from "@kernel/diff-hunks.ts";
import { entryKey, type ChangedSymbol } from "@kernel/change-reach.ts";
import { FILE_SEED_SYMBOL, type UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { ContextFit } from "@kernel/context-budget.ts";
import type { BriefCandidate, BriefChange, BriefChangeFile, BriefHunk, ChangeOrigin, ExpectedSource } from "./delegation-brief.ts";
export type { BriefChange, BriefChangeFile, BriefHunk, ChangeOrigin } from "./delegation-brief.ts";
import { flowCovers, type PlannedFlow } from "./plan-coverage.ts";

/* The most steps of a reach path a brief states; a longer one keeps both ends and counts the rest. */
export const MAX_PROOF_STEPS = 8;

/* What the run knows of the change besides the candidates: its diffs (one per repo of the change) and the anchor commit's subject. */
export interface ChangeFacts {
  diffs: readonly string[];
  subject?: string;
}

/* A reach path longer than the bound keeps where it starts (the change) and where it ends (the page), and says how many steps it left out between them. */
export function boundedSteps(proof: readonly string[]): string[] {
  if (proof.length <= MAX_PROOF_STEPS) return [...proof];
  const head = Math.floor((MAX_PROOF_STEPS - 1) / 2);
  const tail = MAX_PROOF_STEPS - 1 - head;
  return [...proof.slice(0, head), `(${proof.length - head - tail} more)`, ...proof.slice(proof.length - tail)];
}

/* The expected behavior's sources, most specific first and always ending with the diff: a declared contract operation, the commit's stated intent, the changed code. */
function expectedFrom(candidate: UseCaseCandidate, facts: ChangeFacts): ExpectedSource[] {
  const sources: ExpectedSource[] = [];
  if (candidate.entry.kind === "operation" && (candidate.basis === "contract" || candidate.entry.operationId !== undefined)) sources.push({ kind: "contract", ref: entryKey(candidate.entry) });
  if (facts.subject !== undefined && facts.subject.trim() !== "") sources.push({ kind: "commit-message", ref: facts.subject.trim() });
  sources.push({ kind: "diff", ref: [...new Set(candidate.seeds.map((seed) => seed.file))].join(", ") || entryKey(candidate.entry) });
  return sources;
}

const symbolText = (seed: ChangedSymbol, shared: boolean): string =>
  `${seed.symbol} (${seed.file}${seed.range ? `:${seed.range.start}-${seed.range.end}` : ""}${shared ? ", shared with other pages" : ""})`;

function briefCandidateOf(candidate: UseCaseCandidate, facts: ChangeFacts): BriefCandidate {
  const symbols = [
    ...candidate.seeds.filter((seed) => seed.symbol !== FILE_SEED_SYMBOL).map((seed) => symbolText(seed, false)),
    ...(candidate.sharedSeeds ?? []).map((seed) => symbolText(seed, true)),
  ];
  return { id: candidate.id, entry: entryKey(candidate.entry), tier: candidate.tier, evidence: boundedSteps(candidate.evidence), symbols: [...new Set(symbols)], expectedFrom: expectedFrom(candidate, facts) };
}

/* The origins of a file for the given candidates, each once, in a fixed order. */
function originsOf(path: string, candidates: readonly UseCaseCandidate[]): ChangeOrigin[] {
  const seeds = candidates.flatMap((c) => c.seeds).filter((seed) => seed.file === path);
  const found = new Set<ChangeOrigin>();
  if (seeds.some((seed) => seed.symbol === FILE_SEED_SYMBOL)) found.add("map-link");
  if (seeds.some((seed) => seed.symbol !== FILE_SEED_SYMBOL)) found.add("graph");
  if (candidates.some((c) => (c.sharedSeeds ?? []).some((seed) => seed.file === path))) found.add("shared");
  return (["map-link", "graph", "shared"] as const).filter((origin) => found.has(origin));
}

const referenceLine = (ref: Pick<HunkReference, "path" | "start" | "end" | "added" | "removed" | "kind">, why: string): string =>
  `${ref.path}:${ref.start}-${ref.end} (+${ref.added} -${ref.removed}, ${ref.kind}, ${why})`;

const REFERENCE_WHY: Record<HunkReference["why"], string> = {
  "owned-by-other-flow": "another flow's",
  unassigned: "no use case's",
  "test-file": "an app test file",
  generated: "generated",
  "low-relevance": "low relevance",
};

/* The class rank of a path: code first, then other kinds, styles, generated and low-relevance files. */
const classRank = (path: string): number => FILE_CLASS_ORDER.indexOf(classifyPath(path));

function hunksOf(slice: ChangeSlice): Array<BriefHunk & { rank: number }> {
  return slice.owned.map((owned) => {
    const { added, removed } = hunkLineCounts(owned.hunk);
    return {
      path: owned.hunk.file,
      start: owned.hunk.newStart,
      end: owned.hunk.newEnd,
      added,
      removed,
      kind: owned.kind,
      code: classifyPath(owned.hunk.file) === "code",
      candidateIds: owned.candidateIds,
      text: [owned.hunk.header, ...owned.hunk.lines].join("\n"),
      rank: classRank(owned.hunk.file),
    };
  });
}

/*
 * The candidates a flow carries and its slice of the change. The slice of each diff of the change is cut for the flow's candidates;
 * owned hunks of every diff are merged by class rank, keeping each slice's own order. References are the hunks of the flow's own
 * files that the slice does not own. No candidate: no change.
 */
export function briefChangeFor(
  flow: Pick<PlannedFlow, "routes" | "candidates">,
  candidates: readonly UseCaseCandidate[] | undefined,
  facts: ChangeFacts,
  options: SliceOptions = {},
): { candidates: BriefCandidate[]; change?: BriefChange } {
  const all = candidates ?? [];
  const cited = flow.candidates.flatMap((id) => all.filter((c) => c.id === id));
  const named = all.filter((c) => !flow.candidates.includes(c.id) && flowCovers({ routes: flow.routes, candidates: [] }, c));
  const picked = [...new Set([...cited, ...named])];
  if (picked.length === 0) return { candidates: [] };
  const ids = picked.map((c) => c.id);
  const files: BriefChangeFile[] = [];
  const hunks: Array<BriefHunk & { rank: number }> = [];
  const references: string[] = [];
  for (const diff of facts.diffs) {
    if (diff.trim() === "") continue;
    const map = buildChangeMap({ diff, candidates: all });
    const slice = sliceFor(map, diff, ids, options);
    const own = map.files.filter((file) => file.seededBy.some((id) => ids.includes(id)));
    const ownPaths = new Set(own.map((file) => file.path));
    files.push(...own.map((file) => ({ path: file.path, kind: file.kind, added: file.added, removed: file.removed, origins: originsOf(file.path, picked) })));
    hunks.push(...hunksOf(slice));
    references.push(...slice.references.filter((ref) => ownPaths.has(ref.path)).map((ref) => referenceLine(ref, REFERENCE_WHY[ref.why])));
  }
  /* A stable sort: within a class each slice keeps its own order (decision rank, then diff order). */
  const ranked = hunks.map((hunk, i) => ({ hunk, i })).sort((a, b) => a.hunk.rank - b.hunk.rank || a.i - b.i).map(({ hunk: { rank: _rank, ...hunk } }) => hunk);
  files.sort((a, b) => classRank(a.path) - classRank(b.path));
  return { candidates: picked.map((c) => briefCandidateOf(c, facts)), change: { files, hunks: ranked, references } };
}

const NOT_PRELOADED = "not preloaded: the brief would not fit the author's window";

/*
 * The change as the author's window admits it, by the fit rule: while the brief is over, owned non-code hunks become references
 * first, then the lowest-ranked code hunks, one at a time. An unknown window preloads everything (the run acts as if nothing
 * limited it). A brief still over with nothing left to reference is returned as it is, its fit saying so. `measure` judges a whole
 * brief that carries the given change.
 */
export function fitBriefChange(change: BriefChange, measure: (change: BriefChange) => ContextFit): { change: BriefChange; fit: ContextFit; referenced: number } {
  let fit = measure(change);
  if (fit.outcome !== "over") return { change, fit, referenced: 0 };
  const moved: BriefHunk[] = [];
  let kept = [...change.hunks];
  const withKept = (): BriefChange => ({ ...change, hunks: kept, references: [...moved.map((h) => referenceLine(h, NOT_PRELOADED)), ...change.references] });
  const nonCode = kept.filter((h) => !h.code);
  if (nonCode.length > 0) {
    moved.push(...nonCode);
    kept = kept.filter((h) => h.code);
    fit = measure(withKept());
  }
  while (fit.outcome === "over" && kept.length > 0) {
    const last = kept[kept.length - 1]!;
    kept = kept.slice(0, -1);
    /* Non-code first, then code in rank order: the order a reader would want them back. */
    const firstCode = moved.findIndex((h) => h.code);
    moved.splice(firstCode === -1 ? moved.length : firstCode, 0, last);
    fit = measure(withKept());
  }
  return { change: withKept(), fit, referenced: moved.length };
}
