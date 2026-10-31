import type { ValidationRunInfo } from "../../domain/validation.ts";

export interface ValidationPort {
  /** `infra` is optional: a validation failure may be infrastructure, not a defect of the specs. */
  validate(specDir: string, run?: ValidationRunInfo): Promise<{ ok: boolean; errors: string[]; infra?: boolean }>;
  /**
   * Applies the linter's own fixes to the delivered specs (`run.deliveredSpecs`) and returns
   * the specs it rewrote. Absent, or a target with no linter fixes: nothing is rewritten.
   */
  autofix?(specDir: string, run: ValidationRunInfo): Promise<string[]>;
}
