import type { ValidationResult } from "../domain/execution-strategy.ts";

type ValidateCodeFn = (repoDir: string, opts: { changedFiles?: string[] }) => Promise<ValidationResult>;

export class CodeValidationStrategy {
  constructor(private readonly validateCode: ValidateCodeFn) {}

  async validate(specDir: string, changedFiles?: string[]): Promise<ValidationResult> {
    return this.validateCode(specDir, { ...(changedFiles ? { changedFiles } : {}) });
  }
}
