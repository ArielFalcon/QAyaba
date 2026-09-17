/* ValidationPort → target-dispatched gates. e2e uses StaticGateAdapter.validateAll (full gate including the zero-assertion guard) — never the granular methods, which would skip that guard. Code uses CodeValidationStrategy (compile-feedback before execution). */
import type { ValidationPort } from "../../application/ports/index.ts";
import type { StaticGateAdapter } from "@contexts/test-execution/infrastructure/static-gate.adapter.ts";
import type { CodeValidationStrategy } from "@contexts/test-execution/infrastructure/code-validation.strategy.ts";
import type { TestTarget } from "@kernel/run-mode.ts";

export interface ValidationPortStrategies {
  e2e: StaticGateAdapter;
  code: CodeValidationStrategy;
}

export interface ValidationPortStaticContext {
  target: TestTarget;
}

export class ValidationPortAdapter implements ValidationPort {
  constructor(
    private readonly strategies: ValidationPortStrategies,
    private readonly ctx: ValidationPortStaticContext,
  ) {}

  async validate(specDir: string, changedFiles?: string[]): Promise<{ ok: boolean; errors: string[]; infra?: boolean }> {
    const result =
      this.ctx.target === "code"
        ? await this.strategies.code.validate(specDir, changedFiles)
        : await this.strategies.e2e.validateAll(specDir);
    return { ok: result.ok, errors: result.errors, infra: result.infra };
  }
}
