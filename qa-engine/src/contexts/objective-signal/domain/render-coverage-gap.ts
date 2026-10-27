/* Renders uncovered changed lines as the enforce-mode regeneration prompt. Pure; no I/O; never throws. */
import type { SurvivedMutant } from "./coverage-collector.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import { entryKey } from "@kernel/change-reach.ts";

type Uncovered = { file: string; lines: number[] }[];

function compactRanges(sorted: number[]): string {
  const parts: string[] = [];
  let start = sorted[0]!;
  let prev = start;
  for (let i = 1; i <= sorted.length; i++) {
    const n = sorted[i];
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    if (n !== undefined) start = prev = n;
  }
  return parts.join(", ");
}

/* The uncovered lines inside a candidate's seeds (a seed with no range holds every line of its file). */
function uncoveredWithin(candidate: UseCaseCandidate, uncovered: Uncovered): Uncovered {
  const out: Uncovered = [];
  for (const u of uncovered) {
    const lines = u.lines.filter((line) => candidate.seeds.some((seed) => seed.file === u.file && (seed.range === undefined || (line >= seed.range.start && line <= seed.range.end))));
    if (lines.length > 0) out.push({ file: u.file, lines });
  }
  return out;
}

/*
 * With the candidates the change makes testable, the gap is grouped under the candidate whose seeds hold each line, so the one
 * regeneration is aimed at a use case; lines no candidate holds stay under their own heading. Without candidates the text is the
 * ungrouped one.
 */
function renderGroupedGap(uncovered: Uncovered, candidates: readonly UseCaseCandidate[], max: number): string {
  const sections: string[] = [];
  const claimed = new Map<string, Set<number>>();
  for (const candidate of candidates) {
    const held = uncoveredWithin(candidate, uncovered);
    if (held.length === 0) continue;
    for (const u of held) {
      const set = claimed.get(u.file) ?? new Set<number>();
      u.lines.forEach((line) => set.add(line));
      claimed.set(u.file, set);
    }
    sections.push(`${candidate.id} (${entryKey(candidate.entry)}):\n${held.slice(0, max).map((u) => `  - ${u.file}: lines ${compactRanges(u.lines)}`).join("\n")}${held.length > max ? `\n  …and ${held.length - max} more file(s)` : ""}`);
  }
  const rest = uncovered.map((u) => ({ file: u.file, lines: u.lines.filter((line) => !claimed.get(u.file)?.has(line)) })).filter((u) => u.lines.length > 0);
  if (rest.length > 0) sections.push(`other changed lines:\n${rest.slice(0, max).map((u) => `  - ${u.file}: lines ${compactRanges(u.lines)}`).join("\n")}${rest.length > max ? `\n  …and ${rest.length - max} more file(s)` : ""}`);
  return `changed lines NOT exercised by any test, by use case:\n${sections.join("\n")}`;
}

export function renderCoverageGap(uncovered: Uncovered, max = 10, candidates: readonly UseCaseCandidate[] = []): string {
  if (uncovered.length === 0) return "all changed lines are covered by the tests";
  if (candidates.some((c) => uncoveredWithin(c, uncovered).length > 0)) return renderGroupedGap(uncovered, candidates, max);
  const lines = uncovered.slice(0, max).map((u) => `- ${u.file}: lines ${compactRanges(u.lines)}`);
  const more = uncovered.length > max ? `\n…and ${uncovered.length - max} more file(s)` : "";
  return `changed lines NOT exercised by any test:\n${lines.join("\n")}${more}`;
}

type Untaken = { file: string; line: number; kind: string; arm: string }[];

/* Renders the arms on changed lines no test ran, for a coverage or branch-case regeneration; empty when every arm ran. */
export function renderBranchGap(untaken: Untaken, max = 20): string {
  if (untaken.length === 0) return "";
  const lines = untaken.slice(0, max).map((u) => `- ${u.file}:${u.line} ${u.kind}: ${u.arm}`);
  const more = untaken.length > max ? `\n…and ${untaken.length - max} more arm(s)` : "";
  return `decision arms on changed lines that NO test ran (each is a behaviour the change decides, reached by a test when the page can be brought to that state through the UI against DEV):\n${lines.join("\n")}${more}`;
}

/* A mutant of the changed code that no test noticed, as the fact it is: the line ran under the spec, the mutation was applied and no test failed. */
export function renderSurvivedMutant(m: SurvivedMutant, specFile?: string): string {
  const ran = specFile ? `ran under ${specFile}` : "ran under a test";
  const edit = m.original !== undefined && m.replacement !== undefined ? `, ${JSON.stringify(m.original)} replaced by ${JSON.stringify(m.replacement)}` : "";
  return `mutant of the changed code that NO test noticed: ${m.file}:${m.line} ${ran}; the mutation (${m.operator}${edit}) was applied to the served script and no test failed, so the test reaches this line and asserts nothing that depends on it`;
}

/* The surviving mutants as one gap text for an author that has no lead to route them; empty when none survived. */
export function renderSurvivedMutants(survived: readonly SurvivedMutant[], max = 10): string {
  if (survived.length === 0) return "";
  const lines = survived.slice(0, max).map((m) => `- ${renderSurvivedMutant(m, m.specFiles?.join(", "))}`);
  const more = survived.length > max ? `\n…and ${survived.length - max} more mutant(s)` : "";
  return `mutants of the changed code that ran under a test and that no test noticed:\n${lines.join("\n")}${more}`;
}
