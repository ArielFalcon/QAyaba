/* ValidationPort → the e2e gate. StaticGateAdapter.validateAll is the full gate including the zero-assertion guard — never the granular methods, which would skip that guard. */
import type { ValidationOutcome, ValidationPort } from "../../application/ports/validation.port.ts";
import type { ValidationRunInfo } from "../../domain/validation.ts";
import type { StaticGateAdapter } from "@contexts/test-execution/infrastructure/static-gate.adapter.ts";

export interface ValidationPortStrategies {
  e2e: Pick<StaticGateAdapter, "validateAll"> & Partial<Pick<StaticGateAdapter, "autofix">>;
}

export class ValidationPortAdapter implements ValidationPort {
  constructor(private readonly strategies: ValidationPortStrategies) {}

  async validate(specDir: string, _run?: ValidationRunInfo): Promise<ValidationOutcome> {
    const result = await this.strategies.e2e.validateAll(specDir);
    return { ok: result.ok, errors: result.errors, infra: result.infra, diagnostics: result.diagnostics, untypedErrors: result.untypedErrors };
  }

  /* Only the e2e gate has a linter with fixes of its own. */
  async autofix(specDir: string, run: ValidationRunInfo): Promise<string[]> {
    if (!this.strategies.e2e.autofix) return [];
    return await this.strategies.e2e.autofix(specDir, run.deliveredSpecs ?? []);
  }
}
