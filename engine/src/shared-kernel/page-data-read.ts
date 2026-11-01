/*
 * What one captured page said of DEV's data under the app's declared data state (`dev.dataState`): the raw read the grounding hands the run,
 * and the learning context turns into an observation. A fact about DEV at the time of the read; it carries no verdict and no judgment.
 */

export interface PageDataRead {
  /* What the read is about: the pathname of the address the page was captured at (never its query or fragment), or the template of the map when the page was opened from one. */
  readonly scope: string;
  /* The page rendered with content and ended on the address asked for, so what it says is what that address shows. */
  readonly grounded: boolean;
  /* A `dev.dataState` route matched the page: absent for an app that declares none. */
  readonly dataState: boolean | undefined;
  /* The page's declared data state could not be confirmed at capture time (a result count not read, or read as 0 without two settled reads, or a readiness selector that never appeared). */
  readonly unconfirmed: boolean;
  readonly ready?: boolean;
  /* Results counted on the page; absent when the app declares no result for it. */
  readonly resultCount?: number;
  /* The count was read as 0 on two reads of a settled page: a real empty state. */
  readonly emptyConfirmed?: boolean;
}

/*
 * The pages a run's reads say DEV served with no data: a page read as a confirmed empty state on its own address, that no read of the
 * run read with results. A read of a route template names no single page, so it names none here. Sorted, once each.
 */
export function emptyConfirmedPages(reads: readonly PageDataRead[]): string[] {
  const withResults = new Set(reads.filter((read) => (read.resultCount ?? 0) > 0).map((read) => read.scope));
  const isTemplate = (scope: string): boolean => scope.split("/").some((segment) => segment.startsWith(":") || segment.includes("*"));
  const empty = reads.filter((read) => read.emptyConfirmed === true && read.grounded && !isTemplate(read.scope) && !withResults.has(read.scope)).map((read) => read.scope);
  return [...new Set(empty)].sort();
}

/*
 * A passing case that checked a page only as DEV served it. Either every assertion of its test ran on a page as it loaded, before any
 * step of the test's own, and at least one ran on a page DEV served confirmed empty (`pages`): its pass cannot tell DEV's lack of data
 * from the change's behaviour. Or an assertion that ran as the page loaded holds the number of results the run read on that page
 * (`counts`): the number it asserts is DEV's data of the moment. `file` is the spec's suite-relative path, `test` its title path
 * (describe titles, then the test's, joined by " › "). A fact of the run's reads and the spec's syntax, never a verdict.
 */
export interface AmbientDataPin {
  readonly file: string;
  readonly test: string;
  /* The empty pages it checked. */
  readonly pages: readonly string[];
  /* The pages whose read result count its as-loaded assertions hold, with that count. Absent when none. */
  readonly counts?: readonly { page: string; count: number }[];
}

/* How a citation names a pinned case: `<spec>#<title path>`. */
/* Every page a pin names, the empty ones and the ones whose read result count it asserts. */
export const ambientPinPages = (pin: Pick<AmbientDataPin, "pages" | "counts">): string[] => [...new Set([...pin.pages, ...(pin.counts ?? []).map((read) => read.page)])];

/* Where a pin's case checked a page only as DEV served it: the empty pages, then the pages whose read result count it asserts. */
export const ambientPinReads = (pin: Pick<AmbientDataPin, "pages" | "counts">): string[] => [...pin.pages, ...(pin.counts ?? []).map((read) => `${read.page} (${read.count} results read)`)];

export const ambientPinRef = (pin: Pick<AmbientDataPin, "file" | "test">): string => `${pin.file}#${pin.test}`;
