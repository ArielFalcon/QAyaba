/*
 * A use case the change makes testable: an entry point its changed symbols reach, with how directly, the evidence path, whether
 * a browser can reach it, and the specs the suite already holds for it. Derived deterministically from the change's scope.
 */
import { LanguageRegistry } from "./language-id.ts";
import { entryKey, type ChangedSymbol, type EntryPoint, type ReachBasis, type ReachTier } from "./change-reach.ts";

/* `page` is a page of the app; `via-page` an operation that some page reaches in the browser (`pages` names them); `backend-only` an operation no page reaches. */
export type Reachability = "page" | "via-page" | "backend-only";

export interface CandidateChangedFile {
  file: string;
  /* Absent when the diff of the file was not read. */
  addedLines?: number;
}

/* The seed of a file the map links to a page: no symbol, no range, so every added line of the file is the candidate's. */
export const FILE_SEED_SYMBOL = "*";

/* A hub's changed symbol as one of its pages sees it: the symbol and range, the entries the hub reaches that are pages, and the lines the change added to its file when the diff was read. */
export interface SharedSeed extends ChangedSymbol {
  pages: number;
  addedLines?: number;
}

export interface UseCaseCandidate {
  /* `uc-` and 8 hex digits, stable for the same entry point whatever the order the candidates were derived in. */
  id: string;
  entry: EntryPoint;
  tier: ReachTier;
  basis: ReachBasis;
  evidence: string[];
  seeds: ChangedSymbol[];
  /* Changed symbols that reach this page together with many others, or whose graph walk the budget cut: a hub proves no entry on its own, but it is positive evidence that the change reaches this one. A file seeds the candidate through them as through `seeds` (`candidateSeeds`, `seedingOf` in `change-map.ts`): the change map, the briefs, the gap's grouping and the routing of a finding by its file read both, telling a shared seed apart where it matters (a finding several flows hold goes first to one its file seeds directly; only a direct seed opens a flow for an uncovered use case). Per-candidate coverage reads `seeds`. */
  sharedSeeds?: SharedSeed[];
  /* The changed files that seed the candidate, each with the lines the change added to it when the diff was read. Executable lines are only known once a run has measured them, so a count here is of added lines. */
  changedFiles?: CandidateChangedFile[];
  confidence: number;
  reachability: Reachability;
  pages: string[];
  existingSpecs: string[];
  /* What the suite's manifest declares each existing spec checks, keyed by spec file: the agent's own words, so a claim, not a fact. */
  specObjectives?: Readonly<Record<string, readonly string[]>>;
  /* The map's name for the page, when it has one. */
  label?: string;
}

/* The pages through which a browser reaches the candidates: each page candidate's route and the pages that reach an operation, once each, in the order given. */
export function pageRoutesOf(candidates: readonly UseCaseCandidate[]): string[] {
  return [...new Set(candidates.flatMap(candidatePagesOf))];
}

/* The pages through which a browser reaches the candidate: its own route for a page, the pages that reach it for an operation. */
export function candidatePagesOf(candidate: UseCaseCandidate): string[] {
  if (candidate.entry.kind === "page") return [candidate.entry.route];
  return candidate.reachability === "via-page" ? [...candidate.pages] : [];
}

const MAX_LINE_EVIDENCE_CHARS = 240;
const MAX_LINE_FILES = 4;
const MAX_LINE_SPECS = 3;
const MAX_LINE_OBJECTIVES = 3;
const MAX_LINE_OBJECTIVE_CHARS = 120;

function specWithObjectives(file: string, objectives: readonly string[] | undefined): string {
  const declared = (objectives ?? []).slice(0, MAX_LINE_OBJECTIVES).map((objective) => {
    const flat = objective.replace(/\s+/g, " ").trim();
    return flat.length > MAX_LINE_OBJECTIVE_CHARS ? `${flat.slice(0, MAX_LINE_OBJECTIVE_CHARS)}...` : flat;
  }).filter((objective) => objective !== "");
  return declared.length > 0 ? `${file} (declares: ${declared.join("; ")})` : file;
}

/* A changed file as the lead reads it: its path, the kind the language registry gives it (a declared language, or `other`, which holds styles, templates and data) and the lines the change added to it. */
function changedFileText(changed: CandidateChangedFile): string {
  const kind = LanguageRegistry.languageForFile(changed.file) ?? "other";
  return `${changed.file} (${kind}${changed.addedLines !== undefined ? `, +${changed.addedLines}` : ""})`;
}

/* The changed code that reaches this page together with others, as the lead reads it: file, kind, added lines and how many pages the same code reaches. */
function sharedSeedsText(shared: readonly SharedSeed[]): string {
  if (shared.length === 0) return "";
  const text = shared.slice(0, MAX_LINE_FILES).map((seed) => {
    const kind = LanguageRegistry.languageForFile(seed.file) ?? "other";
    return `${seed.file} (${kind}${seed.addedLines !== undefined ? `, +${seed.addedLines}` : ""}, reaches ${seed.pages} page${seed.pages === 1 ? "" : "s"})`;
  });
  return `shared with other pages: ${text.join(", ")}${shared.length > MAX_LINE_FILES ? `, +${shared.length - MAX_LINE_FILES} more` : ""}`;
}

/* The size of the change a flow would own (its owned slice): the hunks and the lines they add and remove. */
export interface OwnedSliceSize {
  hunks: number;
  added: number;
  removed: number;
}

/* An owned slice as the lead reads it. */
export function ownedSliceText(size: OwnedSliceSize): string {
  return `owns ${size.hunks} hunk${size.hunks === 1 ? "" : "s"} (+${size.added} -${size.removed})`;
}

/*
 * One line that names a candidate to the lead: id, entry, how directly the change reaches it, the changed files that seed it, the
 * part of the diff its flow would own when the run read the diff, the evidence path and the specs the suite already holds for it,
 * each with what its manifest declares it checks. Unsanitized: the caller redacts.
 */
export function candidateLine(candidate: UseCaseCandidate, slice?: OwnedSliceSize): string {
  const evidence = candidate.evidence.join(" > ");
  const cut = evidence.length > MAX_LINE_EVIDENCE_CHARS ? `${evidence.slice(0, MAX_LINE_EVIDENCE_CHARS)}...` : evidence;
  const specs = candidate.existingSpecs.slice(0, MAX_LINE_SPECS).map((file) => specWithObjectives(file, candidate.specObjectives?.[file])).join(", ");
  const files = candidate.changedFiles ?? [];
  const changed = files.length > 0 ? `changed: ${files.slice(0, MAX_LINE_FILES).map(changedFileText).join(", ")}${files.length > MAX_LINE_FILES ? `, +${files.length - MAX_LINE_FILES} more file(s)` : ""}` : "";
  const shared = sharedSeedsText(candidate.sharedSeeds ?? []);
  return [candidate.id, entryKey(candidate.entry), `${candidate.tier}, ${candidate.reachability}`, changed, shared, slice ? ownedSliceText(slice) : "", cut, specs !== "" ? `specs: ${specs}` : "no spec yet"].filter((part) => part !== "").join(" | ");
}
