import type { ValidationResult } from "../../domain/execution-strategy.ts";

export interface CodeValidatePort {
  validate(specDir: string, changedFiles?: string[]): Promise<ValidationResult>;
}
