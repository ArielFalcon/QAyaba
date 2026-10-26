/* Builds the test-execution context: the static validation and the execution of a run's specs, each dispatched to the strategy of the run's target. */

import type { TestTarget } from "@kernel/run-mode.ts";
import type { ExecutionPort, ValidationPort } from "../application/index.ts";
import { ExecutionPortAdapter } from "../infrastructure/adapters/execution-port.adapter.ts";
import { ValidationPortAdapter } from "../infrastructure/adapters/validation-port.adapter.ts";
import type { CodeExecutionStrategy } from "../infrastructure/code-execution.strategy.ts";
import type { CodeValidationStrategy } from "../infrastructure/code-validation.strategy.ts";
import type { E2eExecutionStrategy } from "../infrastructure/e2e-execution.strategy.ts";
import type { StaticGateAdapter } from "../infrastructure/static-gate.adapter.ts";

export interface TestExecutionDeps {
  target: TestTarget;
  validationStrategies: {
    e2e: Pick<StaticGateAdapter, "validateAll"> & Partial<Pick<StaticGateAdapter, "autofix">>;
    code: Pick<CodeValidationStrategy, "validate">;
  };
  executionStrategies: {
    e2e: Pick<E2eExecutionStrategy, "run">;
    code: Pick<CodeExecutionStrategy, "run">;
  };
  /* The per-run namespace the spec output and coverage dumps are written under. */
  namespace: string;
  baseUrl?: string;
  testIdAttribute?: string;
}

export interface TestExecutionApi {
  validation: ValidationPort;
  execution: ExecutionPort;
}

export function buildTestExecution(deps: TestExecutionDeps): TestExecutionApi {
  return {
    validation: new ValidationPortAdapter(
      { e2e: deps.validationStrategies.e2e, code: deps.validationStrategies.code as CodeValidationStrategy },
      { target: deps.target },
    ),
    execution: new ExecutionPortAdapter(
      { e2e: deps.executionStrategies.e2e as E2eExecutionStrategy, code: deps.executionStrategies.code as CodeExecutionStrategy },
      {
        target: deps.target,
        namespace: deps.namespace,
        ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
        ...(deps.testIdAttribute !== undefined ? { testIdAttribute: deps.testIdAttribute } : {}),
      },
    ),
  };
}
