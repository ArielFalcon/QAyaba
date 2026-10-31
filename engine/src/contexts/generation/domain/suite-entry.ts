/* One spec of the suite as the prompt lists it: its path and, when a flow and an objective are known for it, those, folded into one line. The grounding writes the line from the manifest; whoever lists the suite reads the path back from it with `suiteEntryFile` and never the objective (an objective folded into a line belongs to a spec that was there before the run, not to one the lead declared in it). No sanitizing or capping here: this is the line as it has always been, byte for byte, and what lists a line for a regeneration sanitizes and caps it (suite-listing.ts). */
import type { DeliveredSpec } from "@kernel/delivered-spec.ts";

/* Between the path and what is known about it. A dash with a space on each side, so that a name with a dash in it is still one name. */
const SUITE_ENTRY_SEPARATOR = " — ";

/* The path, then each of the flow and the objective that is known, in that order. A text that is empty is still known: the line says what the manifest holds. */
export function formatSuiteEntry(entry: DeliveredSpec): string {
  const facts = [
    ...(entry.flow !== undefined ? [`flow: ${entry.flow}`] : []),
    ...(entry.objective !== undefined ? [`objective: ${entry.objective}`] : []),
  ];
  return facts.length > 0 ? `${entry.file}${SUITE_ENTRY_SEPARATOR}${facts.join(", ")}` : entry.file;
}

/* The path of a line: the text before the first separator, or the whole line when it has none. */
export function suiteEntryFile(line: string): string {
  const at = line.indexOf(SUITE_ENTRY_SEPARATOR);
  return at < 0 ? line : line.slice(0, at);
}
