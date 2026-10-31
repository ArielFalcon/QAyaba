import type { SpecExecutionRequest, SpecExecutionResult } from "../../domain/spec-executor.ts";

/* Executes one spec file once, with no retries, in the sandbox, against DEV. */
export interface SpecExecutorPort {
  execute(request: SpecExecutionRequest): Promise<SpecExecutionResult>;
}
