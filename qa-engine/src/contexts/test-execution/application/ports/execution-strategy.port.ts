import type { ExecutionRequest, ExecutionResult } from "../../domain/execution-strategy.ts";

export interface ExecutionStrategyPort {
  run(req: ExecutionRequest): Promise<ExecutionResult>;
}
