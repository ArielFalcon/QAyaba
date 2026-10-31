/*
 * What one captured page said of DEV's data under the app's declared data state (`dev.dataState`): the raw read the grounding hands the run,
 * and the learning context turns into an observation. A fact about DEV at the time of the read; it carries no verdict and no judgment.
 */

export interface PageDataRead {
  /* What the read is about: the address the page was captured at, or the template of the map when the page was opened from one. */
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
