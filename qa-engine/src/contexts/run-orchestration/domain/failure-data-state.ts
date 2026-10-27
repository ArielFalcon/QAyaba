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
 * Whether a case's failure point shows DEV's data differing from what the pack read or from nothing at all: a settled capture that
 * read an empty data state, or a count other than the pack's on that page. A page still changing at the capture is a moment of a
 * render, not DEV's data state, so it shows nothing.
 */
export function dataStateDiffers(c: QaCase, confirmed: ConfirmedDataRoutes): boolean {
  if (c.failureResultCount === undefined || failureUnsettled(c.failureSettle)) return false;
  if (c.failureResultCount === 0) return true;
  const known = packCountAt(c, confirmed);
  return known !== undefined && known !== c.failureResultCount;
}
