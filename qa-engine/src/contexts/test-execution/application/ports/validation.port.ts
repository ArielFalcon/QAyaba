import type { ValidationRunInfo } from "../../domain/validation.ts";

export interface ValidationPort {
  /**
   * `changedFiles` scopes the code-target compile gate. Ignored by the e2e
   * static gate. Present so the same call site can pass it for either target.
   * `infra` is optional: a validation failure may be infrastructure, not a code defect.
   */
  validate(specDir: string, changedFiles?: string[], run?: ValidationRunInfo): Promise<{ ok: boolean; errors: string[]; infra?: boolean }>;
  /**
   * Applies the linter's own fixes to the delivered specs (`run.deliveredSpecs`) and returns
   * the specs it rewrote. Absent, or a target with no linter fixes: nothing is rewritten.
   */
  autofix?(specDir: string, run: ValidationRunInfo): Promise<string[]>;
}
