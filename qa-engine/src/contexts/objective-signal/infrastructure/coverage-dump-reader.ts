/* Coverage dump readers. Fail-open: an absent, unusable or corrupt dump or report degrades to an empty result — never throws, never waits, never leaves the mirror. An empty report is unmeasured → unknown → never blocks publish. What a run of the tests leaves is the agent's to shape, so every read goes through run-output-reader (the strict read under a cap; what cannot be used is said aloud, quoting nothing of it). The dumps of a run, and the reports of a run, are each used whole or not at all: the coverage of some of them is a ratio of a part of what the run did, lower than the real one, and under enforce it would block a valid change, so when any of them cannot be used none of them is used and the result is empty. */
import { defaultParseV8Coverage, type CoveredLines, type V8Entry } from "./v8-browser-coverage.adapter.ts";
import type { CoverageFile } from "./lcov-coverage.adapter.ts";
import type { IstanbulFile } from "./c8-coverage.adapter.ts";
import type { JacocoFile } from "./jacoco-coverage.adapter.ts";
import { readFirstReport, readRunOutputDir, type RunOutputLimits } from "../../../shared-infrastructure/run-output-reader.ts";

/* A V8 dump carries every script a page loaded, with its source map: about 3 MiB for a 0.6 MiB bundle and 19 MiB for a 3.4 MiB one (measured with esbuild bundles and V8's own precise coverage), and the fixture writes one per test. Each dump is reduced to the lines of the changed files as it is read and none is kept, so a suite of any size costs the memory of one dump, and what the budget bounds is time: decoding ran at some 100 MiB a second on the largest shape measured (114 MiB in a second), so the budget is some twenty seconds of it, a hundred dumps of that size, and a minute at a third of the speed. A dump past the cap, the dumps of one run together past the budget and a directory past the entry cap are far beyond any suite, and are not read: they leave the whole set unused. */
export const MAX_V8_DUMP_BYTES = 64 * 1024 * 1024;
export const MAX_V8_DUMPS_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_V8_DUMP_FILES = 2_048;
export const V8_DUMP_LIMITS: RunOutputLimits = { maxFileBytes: MAX_V8_DUMP_BYTES, maxTotalBytes: MAX_V8_DUMPS_TOTAL_BYTES, maxFiles: MAX_V8_DUMP_FILES };

/* A native report (lcov, Istanbul JSON, JaCoCo XML) is one file; a real one is tens of megabytes at most. */
export const MAX_COVERAGE_REPORT_BYTES = 64 * 1024 * 1024;

/* What a dump covers of the changed files; throws on a dump it cannot decode within its bounds, which leaves the set unused. */
type ParseV8 = (entries: V8Entry[], changedFiles: string[]) => CoveredLines;

/* The lines of `changedFiles` that the dumps of a namespace cover, one entry per dump in the order of their names. Each dump is parsed and reduced inside its read, so the dump itself is garbage as soon as the next one is read: the result is as small as the lines of the changed files, however many dumps and however large. */
export async function readV8Coverage(e2eDir: string, namespace: string, changedFiles: string[], limits: RunOutputLimits = V8_DUMP_LIMITS, parse: ParseV8 = defaultParseV8Coverage): Promise<CoveredLines[]> {
  const rel = `.qa/coverage/${namespace}`;
  const dumps = readRunOutputDir(
    { mirrorDir: e2eDir, specDir: e2eDir },
    rel,
    (name) => name.endsWith(".json"),
    (_name, bytes) => {
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      return parse(Array.isArray(parsed) ? parsed : [], changedFiles);
    },
    limits,
  );
  return dumps ?? [];
}

const text = (path: string, bytes: Buffer): CoverageFile => ({ path, text: bytes.toString("utf8") });

/* Where each kind of report is looked for, in the order. The first that is there stands for the whole report of its kind. */
const LCOV_REPORTS = ["coverage/lcov.info", "lcov.info", "coverage/lcov/lcov.info"];
const ISTANBUL_REPORTS = ["coverage/coverage-final.json"];
const JACOCO_REPORTS = ["target/site/jacoco/jacoco.xml", "build/reports/jacoco/test/jacocoTestReport.xml", "target/jacoco.xml"];

export interface NativeReports {
  lcov: CoverageFile[];
  istanbul: IstanbulFile[];
  jacoco: JacocoFile[];
}

/* The native reports a code run leaves in `repoDir`, of every kind together. A kind with no report contributes nothing; but when a report that is there cannot be used (refused, over the cap, unreadable, not what it should be), none of the kinds is used: the kinds are merged into one measurement of the change, and the part that survives would measure only what the others did. */
export async function readNativeReports(repoDir: string): Promise<NativeReports> {
  const root = { mirrorDir: repoDir, specDir: repoDir };
  const lcov = readFirstReport(root, LCOV_REPORTS, MAX_COVERAGE_REPORT_BYTES, text);
  const istanbul = readFirstReport(root, ISTANBUL_REPORTS, MAX_COVERAGE_REPORT_BYTES, (path, bytes): IstanbulFile => ({
    path,
    json: JSON.parse(bytes.toString("utf8")),
  }));
  const jacoco = readFirstReport(root, JACOCO_REPORTS, MAX_COVERAGE_REPORT_BYTES, text);
  if (lcov === undefined || istanbul === undefined || jacoco === undefined) return { lcov: [], istanbul: [], jacoco: [] };
  return { lcov, istanbul, jacoco };
}
