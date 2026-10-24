/*
 * The lead's read-only code-graph tools for one run. The graph is the orchestrator's (its CLI and its store live in the
 * orchestrator only, and the store holds every app's code), so the lead never reaches it: it asks through the tools endpoint and
 * the orchestrator runs the query on the run's own project, resolved here from the app's mirror, inside the run's scope, under
 * the run's limits. A run whose app is not in the graph, or whose lead runs on a runtime that cannot call a custom tool, is
 * granted nothing. The answer is the graph's JSON, passed through the run's redaction and cut to a size the prompt can take;
 * a query the graph cannot answer is a failed call, with nothing of the CLI's own output.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { CODE_GRAPH_AGENT, DEFAULT_CODE_GRAPH_TOOL_LIMITS, type CodeGraphToolLimits } from "@kernel/code-graph-tools.ts";
import { cliCallOf, type CodeGraphToolRequest, type CodeGraphToolResponse } from "../../domain/code-graph-query.ts";
import type { CodeGraphToolsHandle, CodeGraphToolsOpenInput, CodeGraphToolsPort } from "../../application/ports/index.ts";
import type { CodeGraphToolRegistry } from "../code-graph-tool-registry.ts";
import { traceToolCall, type ToolTraceWiring } from "./tool-call-trace.ts";

export interface CodeGraphToolsPortAdapterDeps {
  registry: CodeGraphToolRegistry;
  client: { cli(tool: string, jsonArg: string, repoDir: string, timeoutMs?: number): Promise<{ code: number | null; stdout: string; stderr: string }> };
  resolver: { resolve(repoDir: string): Promise<string | undefined> };
  /* The repository the run's graph was synced from. */
  repoDir: string;
  /* Whether the lead's role is assigned to a runtime that can call a custom tool (OpenCode). */
  generatorRuntimeCanCall: () => boolean;
  limits?: CodeGraphToolLimits;
  trace?: ToolTraceWiring;
  /* Takes the run's secrets out of an answer; called inside the run's scope. */
  redact?: (text: string) => string;
}

export class CodeGraphToolsPortAdapter implements CodeGraphToolsPort {
  constructor(private readonly deps: CodeGraphToolsPortAdapterDeps) {}

  async open(input: CodeGraphToolsOpenInput): Promise<CodeGraphToolsHandle | undefined> {
    if (!this.deps.generatorRuntimeCanCall()) return undefined;
    const project = await this.deps.resolver.resolve(this.deps.repoDir);
    if (project === undefined) {
      console.warn(`[qa] the code graph has no project for ${this.deps.repoDir}; run ${input.runId} goes on without the code-graph tools`);
      return undefined;
    }
    const limits = this.deps.limits ?? DEFAULT_CODE_GRAPH_TOOL_LIMITS;
    const counts = { calls: 0, refused: 0, failed: 0 };
    let revoked = false;
    /* The run's async context as it is now: its sandbox scope and its secret scope. Every call runs inside it. */
    const inRunContext = AsyncLocalStorage.snapshot();
    const refuse = (code: "wrong-agent" | "revoked" | "no-calls", message: string): CodeGraphToolResponse => {
      counts.refused += 1;
      return { ok: false, code, message };
    };
    const serve = async (request: CodeGraphToolRequest): Promise<CodeGraphToolResponse> => {
      const { tool, json } = cliCallOf(request.query, project);
      const answer = await this.deps.client.cli(tool, json, this.deps.repoDir, limits.perCallMs);
      const stdout = answer.stdout.trim();
      if (answer.code !== 0 || stdout === "") {
        counts.failed += 1;
        return { ok: false, code: "failed", message: "the code graph could not answer this query; check the symbol's name with codegraph_search_graph" };
      }
      const clean = this.deps.redact ? this.deps.redact(stdout) : stdout;
      const truncated = clean.length > limits.maxAnswerChars;
      return { ok: true, result: truncated ? clean.slice(0, limits.maxAnswerChars) : clean, truncated, callsLeft: limits.maxCalls - counts.calls };
    };
    this.deps.registry.register({
      runId: input.runId,
      call: async (request) => {
        if (revoked) return refuse("revoked", "the code graph is no longer available to this run");
        if (request.agent !== CODE_GRAPH_AGENT) return refuse("wrong-agent", "the code graph is available only to the lead");
        if (counts.calls >= limits.maxCalls) return refuse("no-calls", `this run's ${limits.maxCalls} code-graph calls are spent`);
        counts.calls += 1;
        return inRunContext(() =>
          traceToolCall(
            this.deps.trace,
            { span: "qayaba.tool.codegraph", tool: `codegraph_${request.query.action}`, sessionId: request.sessionId, messageId: request.messageId },
            () => serve(request),
            (answer) => ({ "qayaba.tool.outcome": answer.ok ? "ok" : answer.code }),
          ),
        );
      },
    });
    return {
      limits,
      signals: () => ({ ...counts }),
      close: () => {
        revoked = true;
        this.deps.registry.unregister(input.runId);
      },
    };
  }
}
