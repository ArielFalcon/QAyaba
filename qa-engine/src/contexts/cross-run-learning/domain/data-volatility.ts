/*
 * The first lesson kind: DEV's data on a page is not stable. A page that has been read both with results and, confirmed, empty is a page whose
 * results a test cannot assume. Nothing here knows an app: the reads come from the app's own `dev.dataState`, and an app that declares none gives
 * the kind nothing to read (docs/architecture/rfc/0013-learning-slice.md, section 3 and 4).
 */

import type { PageDataRead } from "@kernel/page-data-read.ts";
import type { ServedVersionState } from "@kernel/served-version.ts";
import type { Admission, Lesson, LessonKind, LessonObservation, ObservedFact } from "./lesson-kinds.ts";

/*
 * `equal`: DEV serves the commit under test. `ahead`: DEV serves a descendant, which contains it (hypothesis: the data a route returns does not
 * depend on later code). `behind` serves code older than the change, `unrelated` has no ancestry, `unreadable` and `undeclared` give no state to compare.
 */
const ADMITTED_SERVED_STATES: readonly ServedVersionState[] = ["equal", "ahead"];

function admit(read: PageDataRead, served: ServedVersionState): Admission {
  if (!ADMITTED_SERVED_STATES.includes(served)) return { admitted: false, reason: `served-version:${served}` };
  if (!read.grounded) return { admitted: false, reason: "not-captured" };
  if (read.dataState !== true) return { admitted: false, reason: "no-data-state" };
  if (read.unconfirmed) return { admitted: false, reason: "unconfirmed-read" };
  return { admitted: true };
}

function factOf(read: PageDataRead): ObservedFact {
  return {
    ...(read.resultCount !== undefined ? { resultCount: read.resultCount } : {}),
    ...(read.emptyConfirmed === true ? { emptyConfirmed: true } : {}),
    ...(read.ready !== undefined ? { ready: read.ready } : {}),
  };
}

function deriveVolatility(admitted: readonly LessonObservation[]): Lesson[] {
  const byScope = new Map<string, LessonObservation[]>();
  for (const observation of admitted) {
    if (!observation.admitted || observation.kind !== "data-volatility") continue;
    byScope.set(observation.scope, [...(byScope.get(observation.scope) ?? []), observation]);
  }
  const lessons: Lesson[] = [];
  for (const [scope, reads] of byScope) {
    const withResults = reads.filter((r) => (r.fact.resultCount ?? 0) > 0);
    const empty = reads.filter((r) => r.fact.emptyConfirmed === true && r.fact.resultCount === 0);
    if (withResults.length === 0 || empty.length === 0) continue;
    const used = [...withResults, ...empty];
    lessons.push({
      kind: "data-volatility",
      scope,
      withResults: withResults.length,
      emptyConfirmed: empty.length,
      latestReadAt: used.reduce((latest, r) => (r.at > latest ? r.at : latest), ""),
      evidence: [...new Set(used.map((r) => r.runId))].sort(),
    });
  }
  return lessons.sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
}

export const DATA_VOLATILITY: LessonKind = {
  id: "data-volatility",
  admittedServedStates: ADMITTED_SERVED_STATES,
  admit,
  factOf,
  derive: deriveVolatility,
};
