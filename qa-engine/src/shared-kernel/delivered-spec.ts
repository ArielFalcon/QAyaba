/* The spec files a run has delivered, as every later regeneration of it knows them. An entry is a path and, when the agent that wrote the spec declared them, the flow and the objective it covers. A spec delivered by a sidekick, or one the run did not write, is a path alone: nothing vouches for an objective it never declared. One entry per file, keyed by the canonical form of its path, in the order each file first appeared in. */
import { normalizeSpecPath } from "./spec-path.ts";

/** Agent free text, all three fields (the file is a path the agent reported): whoever renders an entry MUST sanitize and cap it. */
export interface DeliveredSpec {
  /** The spec's path in its canonical form (`normalizeSpecPath`). */
  file: string;
  flow?: string;
  objective?: string;
}

/* What a report declared, trimmed, or undefined when it declared none (absent or blank). */
function declaredText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === "" ? undefined : text;
}

function entryOf(file: string, flow: string | undefined, objective: string | undefined): DeliveredSpec {
  return { file, ...(flow !== undefined ? { flow } : {}), ...(objective !== undefined ? { objective } : {}) };
}

/* The entries with one report of a spec applied, in a new list. A file already carried keeps its place and takes the flow and the objective the report declares, each on its own: the newest declared text wins, and a report that declares none leaves what is carried. A file not carried yet is added at the end. A report that names no file adds nothing. */
export function upsertDeliveredSpec(entries: readonly DeliveredSpec[], update: DeliveredSpec): DeliveredSpec[] {
  const file = normalizeSpecPath(update.file);
  if (file === "") return [...entries];
  const carried = entries.find((entry) => normalizeSpecPath(entry.file) === file);
  const refreshed = entryOf(file, declaredText(update.flow) ?? declaredText(carried?.flow), declaredText(update.objective) ?? declaredText(carried?.objective));
  return carried === undefined ? [...entries, refreshed] : entries.map((entry) => (entry === carried ? refreshed : entry));
}
