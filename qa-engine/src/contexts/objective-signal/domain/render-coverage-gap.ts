/* Renders uncovered changed lines as the enforce-mode regeneration prompt. Pure; no I/O; never throws. */

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

export function renderCoverageGap(uncovered: Uncovered, max = 10): string {
  if (uncovered.length === 0) return "all changed lines are covered by the tests";
  const lines = uncovered.slice(0, max).map((u) => `- ${u.file}: lines ${compactRanges(u.lines)}`);
  const more = uncovered.length > max ? `\n…and ${uncovered.length - max} more file(s)` : "";
  return `changed lines NOT exercised by any test:\n${lines.join("\n")}${more}`;
}
