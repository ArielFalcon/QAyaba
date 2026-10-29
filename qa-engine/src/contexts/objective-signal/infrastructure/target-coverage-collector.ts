/* A THIN factory — no coverage-ratio or line-mapping logic lives here (that stays in DecideCoverageService). It builds the real coverage collector from the V8 browser dumps of an e2e run, the only signal source for browser-driven runs. Fail-open by construction: the dump reader degrades to an empty report on missing or corrupt data, so "unknown" (no coverage measured) never blocks publish; nothing here can fabricate coverage: the dumps of a run are read as a whole, and when any of them cannot be used none of them is. */
import type { CoverageCollectorPort } from "../application/ports/coverage-collector.port.ts";
import { V8BrowserCoverageAdapter } from "./v8-browser-coverage.adapter.ts";
import { readV8Coverage } from "./coverage-dump-reader.ts";

export function makeTargetCoverageCollector(changedFiles: string[]): CoverageCollectorPort {
  return new V8BrowserCoverageAdapter((specDir, namespace, changed, scripts, branches, keep, executable, mutant, ranBy) => readV8Coverage(specDir, namespace, changed, undefined, undefined, undefined, scripts, branches, keep, executable, mutant, ranBy), changedFiles);
}
