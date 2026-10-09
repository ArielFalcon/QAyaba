/* The listing of the suite for a regeneration. A regeneration is told which specs there are (the ones the suite had before the run, and the ones this run delivered), which of them the turn must change or extend (editable) and which it must leave alone (do-not-rewrite). Pure: what the turn is asks nothing but the signals the generation input already carries.
   Of a spec an entry hands out its text and two facts, and nothing else. The text is made here once, as one line, passed through the sanitizer this function is given and then capped, so that no entry carries a line break, a secret or an unbounded text into a prompt; it is the only thing of an agent's that a listing holds. The canonical path of a spec is what the turn's signals are matched against and stays inside `buildSuiteListing`.
   What this module does not do is render: the headings, the "(+N more)" lines and the plain list a turn with nothing editable gets are the prompt builder's, and the instructions to read an editable spec and to ask the objective again follow from `editable` and `reaskObjective`.
   A spec is editable because a signal of the turn names it (named), or because the turn cannot say which spec to change and takes every spec this run delivered (unnamed). Which specs, by the turn:
   - FixLoop, when a failing case names its file: exactly the failing files, matched to the entries at folder boundaries. Nothing else widens the turn: not the error text of a failing test, a review correction, a selector contradiction or a coverage gap. A failing file that matches no entry is appended as an editable entry of its own.
   - a fix whose failing cases name no file (a static fix, a case the report gave no file for): the specs their error text names, and no other. A fix turn tells the agent to leave the tests that passed alone, so it never takes the specs this run delivered.
   - pre-exec, selector contradictions: the specs they are attributed to; none attributed, every spec this run delivered.
   - reviewer corrections: the specs each correction names; a correction that names none adds every spec this run delivered.
   - coverage: every spec this run delivered, and the turn may add a spec of its own.
   The specs a signal names are all shown. The specs only the fallback adds are shown up to a cap and the rest are counted, so that a run that delivered many specs cannot make the section outgrow the prompt. */
import type { QaCase } from "@kernel/qa-case.ts";
import { upsertDeliveredSpec, type DeliveredSpec } from "@kernel/delivered-spec.ts";
import { normalizeSpecPath } from "@kernel/spec-path.ts";
import { formatSuiteEntry, suiteEntryFile } from "./suite-entry.ts";

/* How many do-not-rewrite entries a listing shows; the rest are counted. */
export const LISTING_MAX_DO_NOT_REWRITE = 30;

/* How many unnamed editable entries a listing shows; the rest are counted. The editable entries a signal names are never capped. */
export const LISTING_MAX_UNNAMED_EDITABLE = 30;

/* The longest text of an entry, in characters, the mark that says it was cut included. */
export const LISTING_MAX_ENTRY_CHARS = 400;

/* The tags with which a reviewer disputes what a spec is for. A correction carries its tag first. */
const OBJECTIVE_DISPUTE = /^\s*\[(?:wrong-objective|false-positive)\]/i;

export interface SuiteListingInput {
  /** The specs of the suite as the grounding folded them before the run, one line each (`formatSuiteEntry`). Absent: the suite is not listed. */
  existing?: readonly string[];
  /** Every spec this run has delivered so far, whose file is still there. */
  delivered?: readonly DeliveredSpec[];
  /** The failing cases of a FixLoop or static-fix turn. */
  fixCases?: readonly QaCase[];
  reviewCorrections?: readonly string[];
  /** The changed lines a green run left unexercised: present on a coverage turn. */
  coverageGap?: string;
  /** Selector contradictions name a selector, never a spec; `attributedSpecFiles` are the specs the checks say raised them. */
  selectorContradictions?: readonly string[];
  attributedSpecFiles?: readonly string[];
}

export interface ListingOptions {
  /** Makes the text of an entry safe to send to a model. It is asked once per entry, for a single line, and before the text is capped. A sanitizer that throws makes the listing throw: no entry is made from a text it did not pass. */
  sanitize: (text: string) => string;
}

export interface ListingEntry {
  /** The entry as it is shown: one line, sanitized and capped. The only field of a listing that holds anything an agent wrote. */
  readonly text: string;
  /** This run delivered the spec. */
  readonly delivered: boolean;
  /** The lead declared an objective for the spec in this run. A suite line's folded objective was not declared by this run's lead, and a sidekick declares none. */
  readonly leadObjective: boolean;
}

export interface SuiteListing {
  /** Every spec: the suite's, in the order given, then those only this run delivered, then failing files the suite did not list. */
  readonly entries: readonly ListingEntry[];
  /** The entries the turn must change or extend, in the order of `entries` (the same objects): the named ones and every unnamed one, shown or not. */
  readonly editable: readonly ListingEntry[];
  /** The editable entries a signal of the turn names, in the order of `entries`. All of them are shown, however many there are. */
  readonly named: readonly ListingEntry[];
  /** The editable entries no signal names, which the turn has because it could not say which spec to change: the specs this run delivered, less the named ones. These are the ones that are shown, in the order of `entries`: at most LISTING_MAX_UNNAMED_EDITABLE. */
  readonly unnamed: readonly ListingEntry[];
  /** How many unnamed editable entries `unnamed` leaves out. */
  readonly unnamedLeftOut: number;
  /** The entries the turn must leave alone that are shown (the same objects as in `entries`): at most LISTING_MAX_DO_NOT_REWRITE, this run's own specs before the suite's. */
  readonly doNotRewrite: readonly ListingEntry[];
  /** How many do-not-rewrite entries `doNotRewrite` leaves out. */
  readonly leftOut: number;
  /** Whether the turn may add a spec of its own beside the ones it changes: a coverage turn, which writes tests for the changed lines nothing exercised. */
  readonly mayAddSpec: boolean;
  /** Whether the turn asks the objective again. It does not when the turn has specs to change, every one of them has an objective its lead declared in this run, and no correction that starts with [wrong-objective] or [false-positive] names one of them. A suite line's folded objective and a sidekick's spec count as having none, and a disputing correction that names no spec is taken to dispute them all. */
  readonly reaskObjective: boolean;
}

/* A text that is one line, safe, and no longer than the limit (counted in characters, so that no character is cut in two). */
function shown(raw: string, sanitize: (text: string) => string): string {
  const characters = [...sanitize(raw.replace(/\s+/g, " ").trim())];
  return characters.length <= LISTING_MAX_ENTRY_CHARS ? characters.join("") : `${characters.slice(0, LISTING_MAX_ENTRY_CHARS - 1).join("")}…`;
}

/* The runs of name characters in a text, each as a canonical path: a full stop that ends a sentence is not part of the name, and a position after the name (`:12:5`) is not a name character. A run with nothing left (an ellipsis) is the empty path, which names no spec. */
function pathTokens(text: string): string[] {
  return Array.from(text.matchAll(/[A-Za-z0-9._@/\\-]+/g), ([run]) => normalizeSpecPath(run.replace(/\.+$/, "")));
}

/* A path names an entry when it is its path, or one of the two ends at a folder boundary of the other: a name alone names every entry with that name, and a path with folders above the suite's names the entry under them. */
function names(token: string, file: string): boolean {
  return token === file || file.endsWith(`/${token}`) || token.endsWith(`/${file}`);
}

export function buildSuiteListing(input: SuiteListingInput, options: ListingOptions): SuiteListing {
  const { sanitize } = options;
  const corrections = input.reviewCorrections ?? [];
  /* Every spec by its canonical path, in the order they were first listed. */
  const known = new Map<string, ListingEntry>();

  for (const line of input.existing ?? []) {
    const file = normalizeSpecPath(suiteEntryFile(line));
    if (file === "" || known.has(file)) continue;
    known.set(file, { text: shown(line, sanitize), delivered: false, leadObjective: false });
  }

  /* The delivered list is read as the run keeps it: one entry per file, the newest declaration of each. */
  for (const spec of (input.delivered ?? []).reduce<DeliveredSpec[]>((merged, delivered) => upsertDeliveredSpec(merged, delivered), [])) {
    const prior = known.get(spec.file);
    const declares = spec.flow !== undefined || spec.objective !== undefined;
    known.set(spec.file, {
      text: prior !== undefined && !declares ? prior.text : shown(formatSuiteEntry(spec), sanitize),
      delivered: true,
      leadObjective: spec.objective !== undefined,
    });
  }

  /* What the turn's signals are matched against: the specs listed so far, so that a file appended below is never what a later one matches. */
  const listed = [...known];
  const namedBy = (token: string): string[] => listed.filter(([file]) => names(token, file)).map(([file]) => file);
  /* The specs a text names. */
  const namedIn = (text: string): string[] => pathTokens(text).flatMap(namedBy);
  /* The specs a signal of the turn names. */
  const namedFiles = new Set<string>();
  const nameAll = (files: readonly string[]): void => files.forEach((file) => namedFiles.add(file));

  const failingCases = (input.fixCases ?? []).filter((fixCase) => fixCase.status !== "pass");
  const failingFiles = [...new Set(failingCases.map((fixCase) => normalizeSpecPath(fixCase.file ?? "")).filter((file) => file !== ""))];
  /* A fix changes what its failing cases name and no other spec: its prompt tells the agent to leave the tests that passed alone, so no fallback widens it. */
  const fixing = failingCases.length > 0;
  /* What the corrections and the contradictions of the turn each name; one that names no spec leaves the turn unable to say which spec to change. */
  const signals: string[][] = [];

  if (failingFiles.length > 0) {
    /* A failing case that names its file settles the turn: those files, and no other, are its work. */
    for (const file of failingFiles) {
      const matches = namedBy(file);
      if (matches.length > 0) {
        nameAll(matches);
      } else {
        known.set(file, { text: shown(file, sanitize), delivered: false, leadObjective: false });
        namedFiles.add(file);
      }
    }
  } else {
    /* Otherwise the error text of a failing case names its spec, and each correction and contradiction the specs it points at. Selector contradictions name a selector, so it is the specs they are attributed to that count. */
    for (const fixCase of failingCases) {
      if (fixCase.detail !== undefined) nameAll(namedIn(fixCase.detail));
    }
    const attributed = new Set(input.attributedSpecFiles?.map(normalizeSpecPath));
    signals.push(...corrections.map((correction) => namedIn(correction)));
    if ((input.selectorContradictions?.length ?? 0) > 0) signals.push(listed.filter(([file]) => attributed.has(file)).map(([file]) => file));
    signals.forEach(nameAll);
  }

  const all = [...known];
  /* A coverage gap, or something to correct that names no spec of the listing, leaves the turn unable to say which spec to change: the specs this run delivered are where it can be. A fix turn takes none. */
  const takesDelivered = !fixing && (Boolean(input.coverageGap) || signals.some((files) => files.length === 0));
  const taken = takesDelivered ? all.filter(([file, entry]) => entry.delivered && !namedFiles.has(file)) : [];
  const unnamed = taken.slice(0, LISTING_MAX_UNNAMED_EDITABLE).map(([, entry]) => entry);
  const editable = new Set([...namedFiles, ...taken.map(([file]) => file)]);
  const changing = all.filter(([file]) => editable.has(file)).map(([, entry]) => entry);
  const rest = all.filter(([file]) => !editable.has(file)).map(([, entry]) => entry);
  const ordered = [...rest.filter((entry) => entry.delivered), ...rest.filter((entry) => !entry.delivered)];
  const doNotRewrite = ordered.slice(0, LISTING_MAX_DO_NOT_REWRITE);
  const disputes = corrections.filter((correction) => OBJECTIVE_DISPUTE.test(correction));
  return {
    entries: all.map(([, entry]) => entry),
    editable: changing,
    named: all.filter(([file]) => namedFiles.has(file)).map(([, entry]) => entry),
    unnamed,
    unnamedLeftOut: taken.length - unnamed.length,
    doNotRewrite,
    leftOut: ordered.length - doNotRewrite.length,
    mayAddSpec: !fixing && Boolean(input.coverageGap),
    reaskObjective:
      changing.length === 0 ||
      changing.some((entry) => !entry.leadObjective) ||
      disputes.some((correction) => {
        const mentioned = namedIn(correction);
        return mentioned.length === 0 || mentioned.some((file) => editable.has(file));
      }),
  };
}
