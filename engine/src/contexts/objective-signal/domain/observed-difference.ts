/* What a mutation moved. A surviving mutant is a fault the suite reached and checked nothing of; the author can write the assertion that kills it only if it knows what the fault changes that a page shows. The same tests run three times, twice without the mutation and once with it, and the pages are compared per test: the requests it depended on (method, origin and pathname; how many times is not compared, a poll that ran once more is noise) and the lines of the accessible tree it ended on. What differs between the two unmutated runs is run-to-run noise (a refreshed token, a tile the map chose, a price DEV changed) and is never reported: a request or a line moved only when neither unmutated run showed it and the mutated run did, or both showed it and the mutated run did not. Only the app's own requests are compared (the ones the run's origin classifier lists): a third party's, or a host the run does not reach, is the page's environment and no assertion can depend on it. Only the tests that passed in all three runs are compared. The difference is told per spec file too, so a survivor reaches only the files whose own pages moved. It is a fact for the regeneration and the record; the mutant itself (the served script and its edit) is not part of it. Pure; a signal, never a gate. */
import type { MovedLists, ObservedDifference } from "@kernel/observed-difference.ts";
import type { RequestOriginRole } from "@kernel/observed-requests.ts";
import { MAX_OBSERVED_LINE_CHARS, type ObservedPage } from "./observed-page.ts";

/* The most items one list of what moved keeps; the rest is counted in `omitted`. */
export const MAX_MOVED_ITEMS = 10;
/* The most test names a difference names. */
export const MAX_MOVED_TESTS = 5;

export type { MovedLists, ObservedDifference };

/* The pages of the two unmutated runs of the same tests; either is undefined when that run left no observation. */
export type UnmutatedPages = readonly [readonly ObservedPage[] | undefined, readonly ObservedPage[] | undefined];

/* What one spec file's tests moved: the difference over that file's tests alone. */
export interface SpecFileDifference {
  spec: string;
  moved: ObservedDifference;
}

const cut = (line: string): string => (line.length > MAX_OBSERVED_LINE_CHARS ? `${line.slice(0, MAX_OBSERVED_LINE_CHARS)}…` : line);
const requestKey = (r: { method: string; url: string }): string => `${r.method} ${r.url}`;
const appRequestKeys = (requests: readonly { method: string; url: string }[], originRole: (url: string) => RequestOriginRole): string[] =>
  requests.filter((r) => originRole(r.url) === "listed").map(requestKey);

/* `from` appended to `into` without repeats. */
function addAll(into: string[], from: readonly string[]): void {
  for (const item of from) if (!into.includes(item)) into.push(item);
}

/*
 * One test's items (requests or tree lines) against the two unmutated runs: added are the mutated run's items neither unmutated run
 * showed, removed the items both unmutated runs showed that the mutated run did not. An item only one unmutated run showed is noise.
 */
function movedItems(first: readonly string[], second: readonly string[], mutant: readonly string[]): { added: string[]; removed: string[] } {
  const a = new Set(first);
  const b = new Set(second);
  const after = new Set(mutant);
  return {
    added: [...after].filter((item) => !a.has(item) && !b.has(item)),
    removed: [...a].filter((item) => b.has(item) && !after.has(item)),
  };
}

/*
 * The difference between the unmutated runs' pages (`baseline`) and the mutated run's (`mutant`), over the tests named in
 * `comparable` (the ones that passed in every run), matched by name. Unobserved when either unmutated run or the mutated run left no
 * observation: without both unmutated runs there is no noise floor, so nothing is claimed.
 */
export function diffObservations(baseline: UnmutatedPages, mutant: readonly ObservedPage[] | undefined, comparable: ReadonlySet<string>, originRole: (url: string) => RequestOriginRole): ObservedDifference {
  const [firstRun, secondRun] = baseline;
  if (firstRun === undefined || secondRun === undefined) return { kind: "unobserved", reason: "baseline" };
  if (mutant === undefined) return { kind: "unobserved", reason: "mutant" };
  const first = new Map(firstRun.map((p) => [p.name, p]));
  const second = new Map(secondRun.map((p) => [p.name, p]));
  const requests: MovedLists = { added: [], removed: [] };
  const dom: MovedLists = { added: [], removed: [] };
  const tests: string[] = [];
  let compared = 0;
  for (const after of mutant) {
    const one = first.get(after.name);
    const two = second.get(after.name);
    if (!one || !two || !comparable.has(after.name)) continue;
    compared++;
    const req = movedItems(appRequestKeys(one.requests, originRole), appRequestKeys(two.requests, originRole), appRequestKeys(after.requests, originRole));
    const tree = movedItems(one.dom, two.dom, after.dom);
    if ([req.added, req.removed, tree.added, tree.removed].every((list) => list.length === 0)) continue;
    tests.push(after.name);
    addAll(requests.added, req.added);
    addAll(requests.removed, req.removed);
    addAll(dom.added, tree.added.map(cut));
    addAll(dom.removed, tree.removed.map(cut));
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

/* The difference of each of `specFiles`, over the comparable tests `fileOf` places in it; a test no file is known for is in none. */
export function movedBySpecFile(
  baseline: UnmutatedPages,
  mutant: readonly ObservedPage[] | undefined,
  comparable: ReadonlySet<string>,
  fileOf: (testName: string) => string | undefined,
  specFiles: readonly string[],
  originRole: (url: string) => RequestOriginRole,
): SpecFileDifference[] {
  return specFiles.map((spec) => ({ spec, moved: diffObservations(baseline, mutant, new Set([...comparable].filter((name) => fileOf(name) === spec)), originRole) }));
}
