/* What a case's failure point read of DEV's data, compared with what the Context Pack read of the same page. Pure. */

import { failureUnsettled, type QaCase } from "@kernel/qa-case.ts";

/* The routes the Context Pack read with a result count, by pathname. */
export type ConfirmedDataRoutes = readonly { path: string; resultCount: number }[] | undefined;

function pathnameOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

/* The result count the Context Pack read on the page the case's failure point was on; undefined when it read none there. */
export function packCountAt(c: QaCase, confirmed: ConfirmedDataRoutes): number | undefined {
  const path = pathnameOf(c.finalUrl);
  return path === undefined ? undefined : confirmed?.find((route) => route.path === path)?.resultCount;
}

/* A failed case whose failure point read an empty data state on a page the Context Pack read with results: two observations of the same page disagree, so the failure is no evidence against the test. */
export function contradictsPack(c: QaCase, confirmed: ConfirmedDataRoutes): boolean {
  if (c.failureResultCount !== 0) return false;
  return (packCountAt(c, confirmed) ?? 0) > 0;
}

/*
 * Whether a case's failure point shows DEV's data differing from what the pack read: a settled capture that read an empty data state
 * on a page the pack read with results, or a count other than the pack's on that page. An empty state with no pack evidence that the
 * page normally has results is what a test that asserts an empty state legitimately reads, so it shows nothing. A page still changing
 * at the capture is a moment of a render, not DEV's data state, so it shows nothing either.
 */
export function dataStateDiffers(c: QaCase, confirmed: ConfirmedDataRoutes): boolean {
  if (c.failureResultCount === undefined || failureUnsettled(c.failureSettle)) return false;
  return readsDifferently(pathnameOf(c.finalUrl), c.failureResultCount, confirmed);
}

/* One settled read of a page's results against the pack's: an empty state where the pack read results, or another count than the pack's. A page the pack read no count for shows nothing. */
function readsDifferently(path: string | undefined, resultCount: number, confirmed: ConfirmedDataRoutes): boolean {
  const known = path === undefined ? undefined : confirmed?.find((route) => route.path === path)?.resultCount;
  return resultCount === 0 ? (known ?? 0) > 0 : known !== undefined && known !== resultCount;
}

/*
 * The data-state failures of a run's final execution, by the page (pathname) the failure point was on: the cases that did not pass and whose
 * failure shows DEV's data differing from what the pack read (`dataStateDiffers`). This is the measure of the lesson slice, not an input to a
 * lesson; it reads no verdict and no error class. Sorted by page.
 */
export function dataStateFailuresOf(cases: readonly QaCase[], confirmed: ConfirmedDataRoutes): Array<{ path: string; count: number }> {
  const byPath = new Map<string, number>();
  for (const c of cases) {
    if (c.status === "pass" || !dataStateDiffers(c, confirmed)) continue;
    const path = pathnameOf(c.finalUrl);
    if (path !== undefined) byPath.set(path, (byPath.get(path) ?? 0) + 1);
  }
  return [...byPath].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, count]) => ({ path, count }));
}

/* A failing test of a `run_spec` call, at the settled point its failure was read: the page (pathname) and the results the page showed there. */
export interface FailureRead {
  path: string;
  resultCount: number;
}

/* The data-state failures among the failure points of a run's `run_spec` calls, by page: the same test as a final execution's case, sorted by page. */
export function dataStateFailuresOfReads(reads: readonly FailureRead[], confirmed: ConfirmedDataRoutes): Array<{ path: string; count: number }> {
  return mergeDataStateFailures(reads.filter((read) => readsDifferently(read.path, read.resultCount, confirmed)).map((read) => ({ path: read.path, count: 1 })));
}

/* Failures by page added up across lists, sorted by page. */
export function mergeDataStateFailures(...lists: ReadonlyArray<ReadonlyArray<{ path: string; count: number }>>): Array<{ path: string; count: number }> {
  const byPath = new Map<string, number>();
  for (const { path, count } of lists.flat()) byPath.set(path, (byPath.get(path) ?? 0) + count);
  return [...byPath].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, count]) => ({ path, count }));
}
