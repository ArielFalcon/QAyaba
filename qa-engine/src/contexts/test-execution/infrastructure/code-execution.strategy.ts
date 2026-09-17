import type { ExecutionStrategyPort, ExecutionRequest, ExecutionResult } from "../application/ports/index.ts";

interface LegacyCodeResult {
  verdict: string;
  cases: { name: string; status: string; detail?: string }[];
  logs: string;
}

type RunCodeFn = (
  repoDir: string,
  opts: {
    namespace: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    changedFiles?: string[];
  },
) => Promise<LegacyCodeResult>;

export class CodeExecutionStrategy implements ExecutionStrategyPort {
  constructor(private readonly runCode: RunCodeFn) {}

  async run(req: ExecutionRequest): Promise<ExecutionResult> {
    const result = await this.runCode(req.specDir, {
      namespace: req.namespace,
      ...(req.signal ? { signal: req.signal } : {}),
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      ...(req.changedFiles ? { changedFiles: req.changedFiles } : {}),
    });
    const cases = result.cases.map((c) => ({
      name: c.name,
      status: c.status as "pass" | "fail" | "flaky",
      ...(c.detail ? { detail: c.detail } : {}),
    }));
    return { verdict: result.verdict as ExecutionResult["verdict"], cases, logs: result.logs };
  }
}
