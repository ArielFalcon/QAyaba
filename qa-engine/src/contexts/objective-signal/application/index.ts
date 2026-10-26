/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export type { CoverageCollectorPort, CoverageReport, ValueOraclePort } from "./ports/index.ts";
export { parseDiffHunks } from "./../domain/assemble-change-coverage.ts";
export { EMPTY_TOKEN_SET, changeTokens } from "./../domain/change-tokens.ts";
export type { ChangeTokenSet } from "./../domain/change-tokens.ts";
export { DecideCoverageService } from "./../domain/decide-coverage.service.ts";
export type { ChangeCoverage, CoveragePolicy } from "./../domain/decide-coverage.service.ts";
export { renderCoverageGap } from "./../domain/render-coverage-gap.ts";
export { diffContracts } from "./../domain/test-intent-contract.ts";
export type { IntentViolation } from "./../domain/test-intent-contract.ts";
