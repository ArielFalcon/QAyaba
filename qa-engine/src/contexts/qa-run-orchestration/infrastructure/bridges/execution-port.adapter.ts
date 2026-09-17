/* ExecutionPort → e2e/code strategy dispatch. Strategies own run/adjudicate. AbortSignal is forwarded. opts.namespace overrides ctx.namespace so enforce-mode coverage regen can use `${runId}-coverage-regen` without colliding with the first run's dumps. A bare AbortSignal second arg is normalized to `{ signal }`. */

import type { ExecutionPort, ExecutionOpts } from "../../application/ports/index.ts";
import type { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy.ts";
import type { CodeExecutionStrategy } from "@contexts/test-execution/infrastructure/code-execution.strategy.ts";
import type { TestTarget } from "@kernel/run-mode.ts";
import type { QaCase } from "@kernel/qa-case.ts";

export interface ExecutionPortStrategies {
  e2e: E2eExecutionStrategy;
  code: CodeExecutionStrategy;
}

export interface ExecutionPortStaticContext {
  target: TestTarget;
  namespace: string;
  baseUrl?: string; /* required for target:"e2e"; absent for target:"code" */
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
    if (this.ctx.target === "code") {
      /* specFiles is e2e-only filtered-retry. Code-mode never forwards it; CodeExecutionStrategy uses changedFiles (which files changed, not which specs failed). */
      return this.strategies.code.run({
        specDir,
        namespace: o.namespace ?? this.ctx.namespace,
        ...(o.signal ? { signal: o.signal } : {}),
      });
    }
    return this.strategies.e2e.run({
      specDir,
      namespace: o.namespace ?? this.ctx.namespace,
      ...(this.ctx.baseUrl ? { baseUrl: this.ctx.baseUrl } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      ...(this.ctx.testIdAttribute !== undefined ? { testIdAttribute: this.ctx.testIdAttribute } : {}),
      ...(o.faultInject !== undefined ? { faultInject: o.faultInject } : {}),
      ...(o.specFiles ? { specFiles: o.specFiles } : {}),
      ...(o.project !== undefined ? { project: o.project } : {}),
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      /* Type-level widening: ExecutionRequest.onCase is structurally narrower than kernel QaCase; E2eExecutionStrategy passes the real QaCase at runtime. */
      ...(o.onCase ? { onCase: (c: { name: string; status: string; detail?: string }) => o.onCase!(c as QaCase) } : {}),
      ...(o.onRunning ? { onRunning: o.onRunning } : {}),
      ...(o.onDiscovered ? { onDiscovered: o.onDiscovered } : {}),
    });
  }
}
