import type { ExecutionRequest, ExecutionResult } from "../../domain/execution-strategy.ts";
import type { ObservedPage } from "@contexts/objective-signal/application/index.ts";

export interface ExecutionStrategyPort {
  run(req: ExecutionRequest): Promise<ExecutionResult<ObservedPage>>;
}
