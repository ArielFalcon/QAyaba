/*
 * How an agent's answer is read, for every answer of the coordination (the lead's plan, review, correction and amendment, the
 * sidekick's result): the contract of RFC-0006. An answer crosses whole. A list of it is read entry by entry; an entry the
 * engine cannot read as the contract says is never read as a default and never skipped in silence: it is returned as an
 * `UnreadableEntry`, recorded where it is read, asked about once in the same session, and the entry still unreadable after that is
 * not acted on. This module is the only place a list of an answer is walked. Pure: no clock, no file, no model.
 */

/* One entry (or the answer itself) the engine could not read: where it sits (`review[2]`, `answer`) and why, in words. */
export interface UnreadableEntry {
  readonly where: string;
  readonly reason: string;
}

export type EntryRead<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

export const entryRead = <T>(value: T): EntryRead<T> => ({ ok: true, value });
export const entryUnreadable = (reason: string): EntryRead<never> => ({ ok: false, reason });

/* The most unreadable entries one answer reports: the rest is a count, so a flooded answer cannot flood a prompt or an event. */
export const MAX_UNREADABLE_LISTED = 12;
const MAX_REASON_CHARS = 240;

export interface EntriesRead<T> {
  readonly entries: T[];
  readonly unreadable: UnreadableEntry[];
}

/*
 * The entries of the list under `field`, each read by `read`. `scrub` redacts what an agent wrote that the reason quotes. A list that
 * is absent is no entries when `optional`, and an unreadable answer otherwise; a value that is not a list is unreadable.
 */
export function readEntries<T>(raw: unknown, field: string, read: (entry: unknown, index: number) => EntryRead<T>, scrub: (text: string) => string, opts: { optional?: boolean } = {}): EntriesRead<T> {
  if (raw === undefined && opts.optional === true) return { entries: [], unreadable: [] };
  if (!Array.isArray(raw)) return { entries: [], unreadable: [{ where: field, reason: raw === undefined ? "it is missing" : "it is not a list" }] };
  const entries: T[] = [];
  const unreadable: UnreadableEntry[] = [];
  raw.forEach((entry: unknown, index) => {
    const result = read(entry, index);
    if (result.ok) entries.push(result.value);
    else unreadable.push({ where: `${field}[${index}]`, reason: scrub(result.reason).slice(0, MAX_REASON_CHARS) });
  });
  return { entries, unreadable };
}

/* The value when it is one of `allowed`, else why it is not. */
export function readOneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): EntryRead<T> {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return entryRead(value as T);
  const shown = value === undefined ? "is missing" : `is ${JSON.stringify(value)?.slice(0, 80) ?? "not a value"}`;
  return entryUnreadable(`${what} ${shown}, not one of ${allowed.join(", ")}`);
}

/* An unreadable entry as one line: where it sits and why. */
export const describeUnreadableEntry = (entry: UnreadableEntry): string => `${entry.where}: ${entry.reason}`;

/* The unreadable entries as lines, at most `MAX_UNREADABLE_LISTED`, then a count of the rest. */
export function describeUnreadable(entries: readonly UnreadableEntry[]): string[] {
  const lines = entries.slice(0, MAX_UNREADABLE_LISTED).map(describeUnreadableEntry);
  return entries.length > MAX_UNREADABLE_LISTED ? [...lines, `and ${entries.length - MAX_UNREADABLE_LISTED} more`] : lines;
}

/* Whether a repaired answer reads better than the first: fewer entries it could not read. A tie keeps the first, which stands. */
export const readsBetter = (second: readonly UnreadableEntry[], first: readonly UnreadableEntry[]): boolean => second.length < first.length;
