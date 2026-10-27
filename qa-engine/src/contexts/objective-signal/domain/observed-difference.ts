/* What a mutation moved. A surviving mutant is a fault the suite reached and checked nothing of; the author can write the assertion that kills it only if it knows what the fault changes that a page shows. The same tests run twice, with the mutation and without it, and the two pages are compared per test: the requests it depended on (method, origin and pathname; how many times is not compared, a poll that ran once more is noise) and the lines of the accessible tree it ended on. Only the tests that passed in both runs are compared. The difference is a fact for the regeneration and the record; the mutant itself (the served script and its edit) is not part of it. Pure; a signal, never a gate. */
import type { MovedLists, ObservedDifference } from "@kernel/observed-difference.ts";
import { MAX_OBSERVED_LINE_CHARS, type ObservedPage } from "./observed-page.ts";

/* The most items one list of what moved keeps; the rest is counted in `omitted`. */
export const MAX_MOVED_ITEMS = 10;
/* The most test names a difference names. */
export const MAX_MOVED_TESTS = 5;

export type { MovedLists, ObservedDifference };

const cut = (line: string): string => (line.length > MAX_OBSERVED_LINE_CHARS ? `${line.slice(0, MAX_OBSERVED_LINE_CHARS)}…` : line);
const requestKey = (r: { method: string; url: string }): string => `${r.method} ${r.url}`;

/* The items of `after` that `before` does not hold, in the order first seen. */
function onlyIn(after: readonly string[], before: ReadonlySet<string>): string[] {
  return after.filter((item) => !before.has(item));
}

/* `from` appended to `into` without repeats. */
function addAll(into: string[], from: readonly string[]): void {
  for (const item of from) if (!into.includes(item)) into.push(item);
}

/*
 * The difference between the unmutated run's pages (`baseline`) and the mutated run's (`mutant`), over the tests named in
 * `comparable` (the ones that passed in both runs), matched by name. Undefined for a run that left no observation.
 */
export function diffObservations(baseline: readonly ObservedPage[] | undefined, mutant: readonly ObservedPage[] | undefined, comparable: ReadonlySet<string>): ObservedDifference {
  if (baseline === undefined) return { kind: "unobserved", reason: "baseline" };
  if (mutant === undefined) return { kind: "unobserved", reason: "mutant" };
  const before = new Map(baseline.map((p) => [p.name, p]));
  const requests: MovedLists = { added: [], removed: [] };
  const dom: MovedLists = { added: [], removed: [] };
  const tests: string[] = [];
  let compared = 0;
  for (const after of mutant) {
    const base = before.get(after.name);
    if (!base || !comparable.has(after.name)) continue;
    compared++;
    const baseRequests = new Set(base.requests.map(requestKey));
    const afterRequests = new Set(after.requests.map(requestKey));
    const baseDom = new Set(base.dom);
    const afterDom = new Set(after.dom);
    const moved = {
      requestsAdded: onlyIn([...afterRequests], baseRequests),
      requestsRemoved: onlyIn([...baseRequests], afterRequests),
      domAdded: onlyIn([...afterDom], baseDom),
      domRemoved: onlyIn([...baseDom], afterDom),
    };
    if (Object.values(moved).every((list) => list.length === 0)) continue;
    tests.push(after.name);
    addAll(requests.added, moved.requestsAdded);
    addAll(requests.removed, moved.requestsRemoved);
    addAll(dom.added, moved.domAdded.map(cut));
    addAll(dom.removed, moved.domRemoved.map(cut));
  }
  if (compared === 0) return { kind: "unobserved", reason: "no-common-test" };
  if (tests.length === 0) return { kind: "unmoved", tests: compared };
  const kept = (list: string[]): string[] => list.slice(0, MAX_MOVED_ITEMS);
  const omitted = [requests.added, requests.removed, dom.added, dom.removed].reduce((sum, list) => sum + Math.max(0, list.length - MAX_MOVED_ITEMS), 0);
  return {
    kind: "moved",
    requests: { added: kept(requests.added), removed: kept(requests.removed) },
    dom: { added: kept(dom.added), removed: kept(dom.removed) },
    tests: tests.slice(0, MAX_MOVED_TESTS),
    ...(omitted > 0 ? { omitted } : {}),
  };
}
