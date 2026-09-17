import type { StaticGatePort, CheckResult, ValidationResult } from "../application/ports/index.ts";

export interface StaticGateChecks {
  typecheck(specDir: string): Promise<CheckResult>;
  lint(specDir: string): Promise<CheckResult>;
  listTests(specDir: string): Promise<CheckResult>;
  checkManifest(specDir: string): Promise<CheckResult>;
  validateAll(specDir: string): Promise<ValidationResult>;
}

export class StaticGateAdapter implements StaticGatePort {
  constructor(private readonly checks: StaticGateChecks) {}
  typecheck(specDir: string): Promise<CheckResult> { return this.checks.typecheck(specDir); }
  lint(specDir: string): Promise<CheckResult> { return this.checks.lint(specDir); }
  listTests(specDir: string): Promise<CheckResult> { return this.checks.listTests(specDir); }
  checkManifest(specDir: string): Promise<CheckResult> { return this.checks.checkManifest(specDir); }
  validateAll(specDir: string): Promise<ValidationResult> { return this.checks.validateAll(specDir); }
}
