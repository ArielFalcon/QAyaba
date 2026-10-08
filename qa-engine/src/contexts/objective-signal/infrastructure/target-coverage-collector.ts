/* This is a THIN factory — no new coverage-ratio or line-mapping logic lives here (that stays in DecideCoverageService, untouched). It exists purely so a real CompositionConfig.objectiveSignal. collector (composition-root.ts's injected slot — currently caller-supplied with no default real wiring) can be constructed without an operator having to hand-roll a bridge to src/'s defaultCollectCoverage(), as shadow-run.operator.ts's makeCoverageCollector GAP had to. Fail-open by construction: every leaf collector degrades to an empty report on missing/corrupt data (see coverage-dump-reader.ts); CoverageCollectorAdapter (the code-target composite) ALSO degrades a throwing or slow collector to empty. The keystone invariant — "unknown" (no coverage measured) NEVER blocks publish — is entirely preserved; nothing here can fabricate coverage: the dumps of an e2e run, and the reports of a code run, are each read as a whole, and when any of them cannot be used none of them is. */
import type { CoverageCollectorPort, CoverageReport } from "../application/ports/index.ts";
import { V8BrowserCoverageAdapter } from "./v8-browser-coverage.adapter.ts";
import { LcovCoverageAdapter } from "./lcov-coverage.adapter.ts";
import { C8CoverageAdapter } from "./c8-coverage.adapter.ts";
import { JacocoCoverageAdapter } from "./jacoco-coverage.adapter.ts";
import { CoverageCollectorAdapter } from "./coverage-collector.adapter.ts";
import { readV8Dumps, readNativeReports } from "./coverage-dump-reader.ts";

export interface TargetCoverageCollectorInput {
  target: "e2e" | "code";
  repoDir: string;
  e2eDir: string;
  changedFiles: string[];
}

/** Builds the real, target-selected CoverageCollectorPort. "e2e" -> V8 browser dumps (the ONLY signal source for browser-driven runs); "code" -> the composite of every native report kind this project's declared Java + JS/TS scope emits (lcov, Istanbul JSON, JaCoCo XML) — an ecosystem with no matching report simply contributes an empty result to the merge (CoverageCollectorAdapter's own fail-open contract), never a false signal. The reports of all the kinds are read together, once per collection: a kind whose report cannot be used would otherwise be missing from the merge while the others were in it, and the ratio of the change would be one of a part. */
export function makeTargetCoverageCollector(input: TargetCoverageCollectorInput): CoverageCollectorPort {
  if (input.target === "e2e") {
    return new V8BrowserCoverageAdapter(readV8Dumps, input.changedFiles);
  }
  return {
    async collect(specDir: string, namespace: string, changedFiles?: string[]): Promise<CoverageReport> {
      const reports = await readNativeReports(specDir);
      return new CoverageCollectorAdapter([
        new LcovCoverageAdapter(async () => reports.lcov, input.repoDir),
        new C8CoverageAdapter(async () => reports.istanbul, input.repoDir),
        new JacocoCoverageAdapter(async () => reports.jacoco, input.changedFiles),
      ]).collect(specDir, namespace, changedFiles);
    },
  };
}
