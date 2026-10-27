/* What a mutation moved, as the run record states it: the same tests were run with and without a mutant of the changed code and their pages compared. The words are the pages' own (a request by method, origin and pathname; a line of the accessible tree); the mutant itself, the served script and its edit, is no part of it. A fact for the regeneration that answers the survivor, never a gate. Types only. */

export interface MovedLists {
  /* Seen only in the mutated run. */
  added: string[];
  /* Seen only in the unmutated run. */
  removed: string[];
}

export type ObservedDifference =
  /* At least one request or one line of the tree is not the same in the two runs. `tests` are the tests it moved in. `omitted` counts the items past the cap of every list together. */
  | { kind: "moved"; requests: MovedLists; dom: MovedLists; tests: string[]; omitted?: number }
  /* Both runs were observed over `tests` comparable tests and nothing the record holds differs. */
  | { kind: "unmoved"; tests: number }
  /* No claim either way: one run left no observation, or no test was observed and passed in both. */
  | { kind: "unobserved"; reason: "baseline" | "mutant" | "no-common-test" };
