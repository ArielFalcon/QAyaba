/* This is a THIN factory — no new coverage-ratio or line-mapping logic lives here (that stays in DecideCoverageService, untouched). It exists purely so a real CompositionConfig.objectiveSignal. collector (composition-root.ts's injected slot — currently caller-supplied with no default real wiring) can be constructed without an operator having to hand-roll a bridge to src/'s defaultCollectCoverage(), as shadow-run.operator.ts's makeCoverageCollector GAP had to. Fail-open by construction: every leaf collector degrades to an empty report on missing/corrupt data (see coverage-dump-reader.ts); CoverageCollectorAdapter (the code-target composite) ALSO degrades a throwing or slow collector to empty. The keystone invariant — "unknown" (no coverage measured) NEVER blocks publish — is entirely preserved; nothing here can fabricate coverage. */
import type { CoverageCollectorPort } from "../application/ports/index.ts";
import { V8BrowserCoverageAdapter } from "./v8-browser-coverage.adapter.ts";
import { LcovCoverageAdapter } from "./lcov-coverage.adapter.ts";
import { C8CoverageAdapter } from "./c8-coverage.adapter.ts";
import { JacocoCoverageAdapter } from "./jacoco-coverage.adapter.ts";
import { CoverageCollectorAdapter } from "./coverage-collector.adapter.ts";
import { readV8Dumps, readLcovFiles, readIstanbulFiles, readJacocoFiles } from "./coverage-dump-reader.ts";

export interface TargetCoverageCollectorInput {
  target: "e2e" | "code";
  repoDir: string;
  e2eDir: string;
  changedFiles: string[];
}

/** Builds the real, target-selected CoverageCollectorPort. "e2e" -> V8 browser dumps (the ONLY signal source for browser-driven runs); "code" -> the composite of every native report kind this project's declared Java + JS/TS scope emits (lcov, Istanbul JSON, JaCoCo XML) — an ecosystem with no matching report simply contributes an empty result to the merge (CoverageCollectorAdapter's own fail-open contract), never a false signal. */
export function makeTargetCoverageCollector(input: TargetCoverageCollectorInput): CoverageCollectorPort {
  if (input.target === "e2e") {
    return new V8BrowserCoverageAdapter(readV8Dumps, input.changedFiles);
  }
  return new CoverageCollectorAdapter([
    new LcovCoverageAdapter(readLcovFiles, input.repoDir),
    new C8CoverageAdapter(readIstanbulFiles, input.repoDir),
    new JacocoCoverageAdapter(readJacocoFiles, input.changedFiles),
  ]);
}
