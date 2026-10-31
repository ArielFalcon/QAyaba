import type { StaticGatePort } from "../application/ports/static-gate.port.ts";
import type { CheckResult, ValidationResult } from "../domain/execution-strategy.ts";

export interface StaticGateChecks {
  typecheck(specDir: string): Promise<CheckResult>;
  lint(specDir: string): Promise<CheckResult>;
  listTests(specDir: string): Promise<CheckResult>;
  checkManifest(specDir: string): Promise<CheckResult>;
  validateAll(specDir: string): Promise<ValidationResult>;
  /** The linter's own fixes for the named specs; returns the specs rewritten. */
  autofix?(specDir: string, specs: readonly string[]): Promise<string[]>;
}

export class StaticGateAdapter implements StaticGatePort {
  constructor(private readonly checks: StaticGateChecks) {}
  typecheck(specDir: string): Promise<CheckResult> { return this.checks.typecheck(specDir); }
  lint(specDir: string): Promise<CheckResult> { return this.checks.lint(specDir); }
  listTests(specDir: string): Promise<CheckResult> { return this.checks.listTests(specDir); }
  checkManifest(specDir: string): Promise<CheckResult> { return this.checks.checkManifest(specDir); }
  validateAll(specDir: string): Promise<ValidationResult> { return this.checks.validateAll(specDir); }
  autofix(specDir: string, specs: readonly string[]): Promise<string[]> { return this.checks.autofix?.(specDir, specs) ?? Promise.resolve([]); }
}
