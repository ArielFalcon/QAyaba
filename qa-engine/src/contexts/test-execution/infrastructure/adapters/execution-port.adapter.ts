/* ExecutionPort → the e2e strategy, which owns run/adjudicate. AbortSignal is forwarded. opts.namespace overrides ctx.namespace so enforce-mode coverage regen can use `${runId}-coverage-regen` without colliding with the first run's dumps. A bare AbortSignal second arg is normalized to `{ signal }`. */

import type { ExecutionPort } from "../../application/ports/execution.port.ts";
import type { ExecutionOpts } from "../../domain/execution.ts";
import type { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy.ts";
import type { QaCase } from "@kernel/qa-case.ts";

export interface ExecutionPortStrategies {
  e2e: E2eExecutionStrategy;
}

export interface ExecutionPortStaticContext {
  namespace: string;
  baseUrl?: string;
  testIdAttribute?: string;
}

/* AbortSignal vs opts bag: class instance vs plain object — unambiguous at runtime. */
function normalizeOpts(opts: AbortSignal | ExecutionOpts | undefined): ExecutionOpts {
  if (!opts) return {};
  if (opts instanceof AbortSignal) return { signal: opts };
  return opts;
}

export class ExecutionPortAdapter implements ExecutionPort {
  constructor(
    private readonly strategies: ExecutionPortStrategies,
    private readonly ctx: ExecutionPortStaticContext,
  ) {}

  async execute(specDir: string, opts?: AbortSignal | ExecutionOpts): ReturnType<ExecutionPort["execute"]> {
    const o = normalizeOpts(opts);
    return this.strategies.e2e.run({
      specDir,
      namespace: o.namespace ?? this.ctx.namespace,
      ...(this.ctx.baseUrl ? { baseUrl: this.ctx.baseUrl } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      ...(this.ctx.testIdAttribute !== undefined ? { testIdAttribute: this.ctx.testIdAttribute } : {}),
      ...(o.specFiles ? { specFiles: o.specFiles } : {}),
      ...(o.retries !== undefined ? { retries: o.retries } : {}),
      ...(o.grep !== undefined ? { grep: o.grep } : {}),
      ...(o.countWrites ? { countWrites: true } : {}),
      ...(o.purpose ? { purpose: o.purpose } : {}),
      ...(o.project !== undefined ? { project: o.project } : {}),
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      /* Type-level widening: ExecutionRequest.onCase is structurally narrower than kernel QaCase; E2eExecutionStrategy passes the real QaCase at runtime. */
      ...(o.onCase ? { onCase: (c: { name: string; status: string; detail?: string }) => o.onCase!(c as QaCase) } : {}),
      ...(o.onRunning ? { onRunning: o.onRunning } : {}),
      ...(o.onDiscovered ? { onDiscovered: o.onDiscovered } : {}),
    });
  }
}
