/* File (repo-relative, POSIX) → set of 1-based line numbers on the new side. Intersection unit for analyze and coverage. */
export type ChangedLines = Map<string, Set<number>>;
