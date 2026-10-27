/* Why a case passed only on retry. A flaky case's first attempt is evidence: when its failure point read an empty data state, on a page the pack read with results, or one other than the pack read, while the same bytes passed on retry, DEV's data moved between attempts and the spec depends on it; anything else is timing. */

import type { QaCase } from "@kernel/qa-case.ts";
import { dataStateDiffers, packCountAt, type ConfirmedDataRoutes } from "./failure-data-state.ts";

/** The flaky triage routes its findings through the lead once per run. */
export const MAX_FLAKY_TRIAGE_CORRECTIONS = 1;

export const FLAKY_CLASS = { DATA_INSTABILITY: "data-instability", TIMING: "timing" } as const;
export type FlakyClass = (typeof FLAKY_CLASS)[keyof typeof FLAKY_CLASS];

export interface FlakyCaseTriage {
  case: QaCase;
  class: FlakyClass;
  /* What the first attempt read, as facts: the data state at its failure point and the pack's count of the same page when it had one. */
  evidence: string;
}

export function classifyFlakyCase(c: QaCase, confirmed: ConfirmedDataRoutes): FlakyClass {
  return dataStateDiffers(c, confirmed) ? FLAKY_CLASS.DATA_INSTABILITY : FLAKY_CLASS.TIMING;
}

function evidenceOf(c: QaCase, confirmed: ConfirmedDataRoutes): string {
  if (c.failureResultCount === undefined) return "its first attempt left no data state to read";
  const pack = packCountAt(c, confirmed);
  return `its first attempt read a result count of ${c.failureResultCount} at the failure point${pack !== undefined ? ` where the Context Pack read ${pack}` : ""}`;
}

/* The flaky cases of a run, each with its class: the cases that failed their first attempt and passed on retry. */
export function triageFlaky(cases: readonly QaCase[], confirmed: ConfirmedDataRoutes): FlakyCaseTriage[] {
  return cases.filter((c) => c.status === "flaky").map((c) => ({ case: c, class: classifyFlakyCase(c, confirmed), evidence: evidenceOf(c, confirmed) }));
}
