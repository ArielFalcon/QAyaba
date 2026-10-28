import type { ExecutionStrategyPort } from "../application/ports/execution-strategy.port.ts";
import type { ExecutionRequest, ExecutionResult } from "../domain/execution-strategy.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { InfraError } from "@kernel/domain-error.ts";
import type { DevWriteRequest } from "../domain/dev-write-request.ts";
import type { SpecLoadError } from "../domain/spec-load-error.ts";

interface E2eRunResultShape { verdict: string; cases: QaCase[]; logs: string; devWrites?: number; unfinishedTests?: number; devWriteRequests?: DevWriteRequest[]; sessionRequests?: DevWriteRequest[]; loadErrors?: SpecLoadError[]; }
type RunE2eFn = (
  specDir: string,
  opts: {
    baseUrl: string;
    namespace: string;
    faultInject?: boolean;
    faultOperations?: ReadonlyArray<{ verb: string; pattern: string }>;
    specFiles?: string[];
    retries?: number;
    grep?: string;
    countWrites?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
    testIdAttribute?: string;
    project?: string;
    onCase?: (c: QaCase) => void;
    onRunning?: (title: string) => void;
    onDiscovered?: (title: string, file?: string) => void;
  },
) => Promise<E2eRunResultShape>;

export class E2eExecutionStrategy implements ExecutionStrategyPort {
  constructor(private readonly runE2E: RunE2eFn) {}

  async run(req: ExecutionRequest): Promise<ExecutionResult> {
    if (!req.baseUrl) throw new InfraError("E2eExecutionStrategy requires a baseUrl (live DEV URL)");
    const result = await this.runE2E(req.specDir, {
      baseUrl: req.baseUrl,
      namespace: req.namespace,
      ...(req.faultInject !== undefined ? { faultInject: req.faultInject } : {}),
      ...(req.faultOperations !== undefined ? { faultOperations: req.faultOperations } : {}),
      ...(req.specFiles ? { specFiles: req.specFiles } : {}),
      ...(req.retries !== undefined ? { retries: req.retries } : {}),
      ...(req.grep !== undefined ? { grep: req.grep } : {}),
      ...(req.countWrites ? { countWrites: true } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      ...(req.testIdAttribute !== undefined ? { testIdAttribute: req.testIdAttribute } : {}),
      ...(req.project !== undefined ? { project: req.project } : {}),
      ...(req.onCase ? { onCase: req.onCase } : {}),
      ...(req.onRunning ? { onRunning: req.onRunning } : {}),
      ...(req.onDiscovered ? { onDiscovered: req.onDiscovered } : {}),
    });
    /*
     * Runner-infra reclassification has ONE owner: e2e-execution.runner.ts's own
     * allFailuresAreRunnerInfra, which runs inside runE2E before this point — both of runE2E's
     * production callers (this strategy AND the fault-injection oracle's own re-run) depend on
     * that SAME upstream check, so this strategy does not re-derive it.
     */
    return { verdict: result.verdict as ExecutionResult["verdict"], cases: result.cases, logs: result.logs, ...(result.devWrites !== undefined ? { devWrites: result.devWrites } : {}), ...(result.unfinishedTests !== undefined ? { unfinishedTests: result.unfinishedTests } : {}), ...(result.devWriteRequests !== undefined ? { devWriteRequests: result.devWriteRequests } : {}), ...(result.sessionRequests !== undefined ? { sessionRequests: result.sessionRequests } : {}), ...(result.loadErrors !== undefined ? { loadErrors: result.loadErrors } : {}) };
  }
}
