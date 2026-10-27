/* Types of the helpers scripts/run-tests.mjs exports for its tests. */
export interface RunTestsOptions {
  workers: number | undefined;
  isolated: boolean;
  recordTimings: boolean;
  verbose: boolean;
  patterns: string[];
  nodeFlags: string[];
}
export interface WorkerGroup {
  cost: number;
  files: string[];
}
export const DEFAULT_TEST_GLOBS: readonly string[];
export const ISOLATED_FILES: ReadonlyMap<string, string>;
export function parseArgs(argv: string[]): RunTestsOptions;
export function expandPatterns(patterns: readonly string[], root: string): string[];
export function balance(files: string[], costOf: (file: string) => number, groups: number): WorkerGroup[];
export function costFunction(timings: Record<string, number>): (file: string) => number;
