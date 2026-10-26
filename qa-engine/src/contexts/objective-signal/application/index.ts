/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export { parseDiffHunks } from "../domain/assemble-change-coverage.ts";
export { EMPTY_TOKEN_SET, changeTokens } from "../domain/change-tokens.ts";
export type { ChangeTokenSet } from "../domain/change-tokens.ts";
export { DecideCoverageService } from "../domain/decide-coverage.service.ts";
export type { ChangeCoverage, CoveragePolicy } from "../domain/decide-coverage.service.ts";
export { renderCoverageGap } from "../domain/render-coverage-gap.ts";
export { diffContracts } from "../domain/test-intent-contract.ts";
export type { IntentViolation, SpecContractExtraction, SpecIntent } from "../domain/test-intent-contract.ts";
export type { IntentContractPort } from "./ports/intent-contract.port.ts";
export type { CoverageCollectorPort } from "./ports/coverage-collector.port.ts";
export type { ObjectiveSignalPort } from "./ports/objective-signal.port.ts";
export type { ValueOraclePort } from "./ports/value-oracle.port.ts";
export type { CoverageReport } from "../domain/coverage-collector.ts";
export type { CoverageMeasurement } from "../domain/objective-signal.ts";
export { assembleChangeCoverage } from "../domain/assemble-change-coverage.ts";
export type { CoverageStatus } from "../domain/decide-coverage.service.ts";
export { MAX_FAULT_INJECTION_COUNTER_BYTES, MAX_FAULT_INJECTION_COUNTER_FILES, MAX_V8_DUMP_BYTES, MAX_V8_DUMP_FILES, MAX_V8_DUMPS_TOTAL_BYTES, sanitizeFaultCounter, sanitizeV8Dump } from "../domain/dump-sanitizers.ts";
