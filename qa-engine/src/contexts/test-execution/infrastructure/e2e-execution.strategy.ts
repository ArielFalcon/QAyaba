import type { ExecutionStrategyPort } from "../application/ports/execution-strategy.port.ts";
import type { ExecutionRequest, ExecutionResult } from "../domain/execution-strategy.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { ExecPurpose } from "@kernel/exec-purpose.ts";
import type { ExecutionConditions } from "@kernel/execution-conditions.ts";
import type { ObservedPage } from "@contexts/objective-signal/application/index.ts";
import { InfraError } from "@kernel/domain-error.ts";
import type { DevWriteRequest } from "../domain/dev-write-request.ts";
import type { SpecLoadError } from "../domain/spec-load-error.ts";
import type { SkippedTest } from "../domain/skipped-test.ts";

interface E2eRunResultShape { verdict: string; cases: QaCase[]; skippedTests?: SkippedTest[]; logs: string; devWrites?: number; unfinishedTests?: number; devWriteRequests?: DevWriteRequest[]; controlRequests?: DevWriteRequest[]; loadErrors?: SpecLoadError[]; conditions?: ExecutionConditions; observations?: ObservedPage[]; }
type RunE2eFn = (
  specDir: string,
  opts: {
    baseUrl: string;
    namespace: string;
    specFiles?: string[];
    retries?: number;
    grep?: string;
    countWrites?: boolean;
    purpose?: ExecPurpose;
    session?: { signedInAt: number };
    coverage?: boolean;
    observe?: boolean;
    mutant?: string;
    tests?: readonly string[];
    globalTimeoutMs?: number;
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

  async run(req: ExecutionRequest): Promise<ExecutionResult<ObservedPage>> {
    if (!req.baseUrl) throw new InfraError("E2eExecutionStrategy requires a baseUrl (live DEV URL)");
    const result = await this.runE2E(req.specDir, {
      baseUrl: req.baseUrl,
      namespace: req.namespace,
      ...(req.specFiles ? { specFiles: req.specFiles } : {}),
      ...(req.retries !== undefined ? { retries: req.retries } : {}),
      ...(req.grep !== undefined ? { grep: req.grep } : {}),
      ...(req.countWrites ? { countWrites: true } : {}),
      ...(req.purpose ? { purpose: req.purpose } : {}),
      ...(req.session ? { session: req.session } : {}),
      ...(req.coverage ? { coverage: true } : {}),
      ...(req.observe ? { observe: true } : {}),
      ...(req.mutant !== undefined ? { mutant: req.mutant } : {}),
      ...(req.tests ? { tests: req.tests } : {}),
      ...(req.globalTimeoutMs !== undefined ? { globalTimeoutMs: req.globalTimeoutMs } : {}),
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
     * production callers (this strategy AND the bundle mutation's re-run) depend on
     * that SAME upstream check, so this strategy does not re-derive it.
     */
    return { verdict: result.verdict as ExecutionResult["verdict"], cases: result.cases, ...(result.skippedTests !== undefined ? { skippedTests: result.skippedTests } : {}), logs: result.logs, ...(result.devWrites !== undefined ? { devWrites: result.devWrites } : {}), ...(result.unfinishedTests !== undefined ? { unfinishedTests: result.unfinishedTests } : {}), ...(result.devWriteRequests !== undefined ? { devWriteRequests: result.devWriteRequests } : {}), ...(result.controlRequests !== undefined ? { controlRequests: result.controlRequests } : {}), ...(result.loadErrors !== undefined ? { loadErrors: result.loadErrors } : {}), ...(result.conditions !== undefined ? { conditions: result.conditions } : {}), ...(result.observations !== undefined ? { observations: result.observations } : {}) };
  }
}
