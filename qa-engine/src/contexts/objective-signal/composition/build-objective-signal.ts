/* Builds the objective-signal context: the change-coverage port the keystone decision reads, and the pure parser of a spec's test intent. */

import type { BundleMutationPort, ChangeCoverage, CoverageCollectorPort, CoveragePolicy, IntentContractPort, ObjectiveSignalPort, ValueOraclePort } from "../application/index.ts";
import { DecideCoverageService } from "../domain/decide-coverage.service.ts";
import { ObjectiveSignalPortAdapter } from "../infrastructure/adapters/objective-signal-port.adapter.ts";
import { extractSpecContract } from "../infrastructure/ts-spec-contract.extractor.ts";

export interface ObjectiveSignalDeps {
  collector: Pick<CoverageCollectorPort, "collect">;
  oracle: Pick<ValueOraclePort, "measure">;
  /* The mutation pass over the served script; absent when the value oracle is off or the target has no browser. */
  mutation?: BundleMutationPort;
  policy: CoveragePolicy;
  /* The working copy the coverage dumps belong to. */
  repoDir: string;
  /* The per-run namespace execution wrote the coverage dumps under. */
  namespace: string;
  /* Absent, or with no per-run diff at measure time: the decision receives null and never blocks. */
  assembleChangeCoverage?: (diff: string, report: Awaited<ReturnType<CoverageCollectorPort["collect"]>>) => ChangeCoverage;
  baselineCases?: string[];
}

export interface ObjectiveSignalApi {
  objectiveSignal: ObjectiveSignalPort;
  /* The intent lock's parser: pure, no I/O, so one instance serves every run. */
  intentContract: IntentContractPort;
}

export function buildObjectiveSignal(deps: ObjectiveSignalDeps): ObjectiveSignalApi {
  return {
    objectiveSignal: new ObjectiveSignalPortAdapter(
      { collector: deps.collector as CoverageCollectorPort, decide: new DecideCoverageService(), oracle: deps.oracle as ValueOraclePort, ...(deps.mutation ? { mutation: deps.mutation } : {}) },
      {
        policy: deps.policy,
        repoDir: deps.repoDir,
        namespace: deps.namespace,
        ...(deps.assembleChangeCoverage ? { assembleChangeCoverage: deps.assembleChangeCoverage } : {}),
        ...(deps.baselineCases ? { baselineCases: deps.baselineCases } : {}),
      },
    ),
    intentContract: { extract: extractSpecContract },
  };
}
