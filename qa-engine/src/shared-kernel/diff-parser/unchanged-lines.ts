/* How many lines of a file, as it is after a change, hold a value and were not touched by the change: the lines that showed the value before it and still do. A line counts once however often it holds the value, and the value stands apart: "Cambiar filtro" is not held by a line that only says "Cambiar filtros". `changed` is the new-side line numbers the diff added (`DiffParserService.changedLines`), absent for a file the diff did not add to. */
export function countUnchangedLinesHolding(source: string, changed: ReadonlySet<number> | undefined, value: string): number {
  if (value === "") return 0;
  let count = 0;
  source.split("\n").forEach((line, index) => {
    if (!changed?.has(index + 1) && holdsStandalone(line, value)) count++;
  });
  return count;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function holdsStandalone(line: string, value: string): boolean {
  for (let at = line.indexOf(value); at !== -1; at = line.indexOf(value, at + 1)) {
    const before = at === 0 ? "" : line[at - 1]!;
    const after = line[at + value.length] ?? "";
    const startsApart = !WORD_CHAR.test(value[0]!) || !WORD_CHAR.test(before);
    const endsApart = !WORD_CHAR.test(value[value.length - 1]!) || !WORD_CHAR.test(after);
    if (startsApart && endsApart) return true;
  }
  return false;
}
