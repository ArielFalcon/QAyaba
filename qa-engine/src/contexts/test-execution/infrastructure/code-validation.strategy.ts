import type { ValidationResult } from "../application/ports/index.ts";

type ValidateCodeFn = (repoDir: string, opts: { changedFiles?: string[] }) => Promise<ValidationResult>;

export class CodeValidationStrategy {
  constructor(private readonly validateCode: ValidateCodeFn) {}

  async validate(specDir: string, changedFiles?: string[]): Promise<ValidationResult> {
    return this.validateCode(specDir, { ...(changedFiles ? { changedFiles } : {}) });
  }
}
