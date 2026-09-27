import type {
  ExecutionStrategyPort,
  ExecutionRequest,
  ExecutionResult,
} from "../application/ports/index.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { InfraError } from "@kernel/domain-error.ts";

interface LegacyRunResult { verdict: string; cases: QaCase[]; logs: string; }
type RunE2eFn = (
  specDir: string,
  opts: {
    baseUrl: string;
    namespace: string;
    faultInject?: boolean;
    specFiles?: string[];
    signal?: AbortSignal;
    timeoutMs?: number;
    testIdAttribute?: string;
    project?: string;
    onCase?: (c: QaCase) => void;
    onRunning?: (title: string) => void;
    onDiscovered?: (title: string, file?: string) => void;
  },
) => Promise<LegacyRunResult>;

export class E2eExecutionStrategy implements ExecutionStrategyPort {
  constructor(private readonly runE2E: RunE2eFn) {}

  async run(req: ExecutionRequest): Promise<ExecutionResult> {
    if (!req.baseUrl) throw new InfraError("E2eExecutionStrategy requires a baseUrl (live DEV URL)");
    const result = await this.runE2E(req.specDir, {
      baseUrl: req.baseUrl,
      namespace: req.namespace,
      ...(req.faultInject !== undefined ? { faultInject: req.faultInject } : {}),
      ...(req.specFiles ? { specFiles: req.specFiles } : {}),
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
     * that SAME upstream check, so re-deriving it here (the deleted AdjudicateService/AppDefect
     * duplicate) was dead weight that never fired against the real runE2E.
     */
    return { verdict: result.verdict as ExecutionResult["verdict"], cases: result.cases, logs: result.logs };
  }
}
