/*
 * The lead's read-only code-graph tool for one run. The graph is the orchestrator's (its engine and its stores live in the
 * orchestrator only, and a store holds a repo's code), so the lead never reaches it: it asks through the tools endpoint and the
 * orchestrator answers over the index the run built, for the run's own repo, inside the run's scope, under the run's limits. A run
 * whose lead runs on a runtime that cannot call a custom tool is granted nothing. The answer is the engine's text, redacted as text
 * (by value and by pattern, the run's own redaction) and cut at a line boundary with every code block closed; a query the index
 * cannot answer is a failed call, with nothing of the engine's own reason told to the lead (the reason is logged and put on the
 * call's span for the operator).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { CODE_GRAPH_EXPLORE_AGENT, CODE_GRAPH_LEAD_AGENT, DEFAULT_CODE_GRAPH_TOOL_LIMITS, type CodeGraphToolLimits } from "@kernel/code-graph-tools.ts";
import { err } from "@kernel/result.ts";
import type { CodeExplorePort } from "@kernel/ports/code-explore.port.ts";
import type { CodeGraphToolRequest, CodeGraphToolResponse } from "../../domain/code-graph-query.ts";
import { shapeExploreAnswer } from "../../domain/explore-answer.ts";
import type { CodeGraphToolsHandle, CodeGraphToolsOpenInput } from "../../domain/code-graph-tools.ts";
import type { CodeGraphToolsPort } from "../../application/ports/code-graph-tools.port.ts";
import type { CodeGraphToolRegistry } from "../code-graph-tool-registry.ts";
import { traceToolCall, type ToolObserver, type ToolTraceWiring } from "./tool-call-trace.ts";

export interface CodeGraphToolsPortAdapterDeps {
  registry: CodeGraphToolRegistry;
  /* The engine's answers over the index the run built. */
  explore: CodeExplorePort;
  /* The repository the run's index was built from. */
  repoDir: string;
  /* Whether the lead's role is assigned to a runtime that can call a custom tool (OpenCode). */
  generatorRuntimeCanCall: () => boolean;
  limits?: CodeGraphToolLimits;
  trace?: ToolTraceWiring;
  /* Takes the run's secrets out of an answer; called inside the run's scope. */
  redact?: (text: string) => string;
}

const MAX_REASON_CHARS = 200;

/* Why the engine could not answer, redacted and bounded: for the operator's log and the call's span, never for the lead. */
function failureReason(reason: string, redact?: (text: string) => string): string {
  return (redact ? redact(reason) : reason).replace(/\s+/g, " ").trim().slice(0, MAX_REASON_CHARS);
}

export class CodeGraphToolsPortAdapter implements CodeGraphToolsPort {
  constructor(private readonly deps: CodeGraphToolsPortAdapterDeps) {}

  async open(input: CodeGraphToolsOpenInput): Promise<CodeGraphToolsHandle | undefined> {
    if (!this.deps.generatorRuntimeCanCall()) return undefined;
    const limits = this.deps.limits ?? DEFAULT_CODE_GRAPH_TOOL_LIMITS;
    const counts = { calls: 0, refused: 0, failed: 0 };
    let revoked = false;
    /* The calls each explore delegation may make, and how many it has made. */
    const shares = new Map<string, { share: number; used: number }>();
    /* The run's async context as it is now: its sandbox scope and its secret scope. Every call runs inside it. */
    const inRunContext = AsyncLocalStorage.snapshot();
    const refuse = (code: "wrong-agent" | "revoked" | "no-calls", message: string): CodeGraphToolResponse => {
      counts.refused += 1;
      return { ok: false, code, message };
    };
    const serve = async (request: CodeGraphToolRequest, observer: ToolObserver): Promise<CodeGraphToolResponse> => {
      const answer = await this.deps.explore.explore(this.deps.repoDir, request.query.terms, limits.maxFiles).catch((cause: unknown) => err({ reason: cause instanceof Error ? cause.message : String(cause) }));
      if (!answer.ok) {
        counts.failed += 1;
        const reason = failureReason(answer.error.reason, this.deps.redact);
        console.error(`[qa] code-graph explore failed for run ${input.runId}: ${reason}`);
        observer.setAttrs({ "qayaba.code_graph.reason": reason });
        return { ok: false, code: "failed", message: "the code graph could not answer this query; try other names (a symbol, a file path or a short code term)" };
      }
      observer.setAttrs({ "qayaba.code_graph.sha": answer.value.indexedSha });
      const { result, truncated } = shapeExploreAnswer(answer.value.text, limits.maxAnswerChars, this.deps.redact);
      return { ok: true, result, truncated, indexedSha: answer.value.indexedSha, callsLeft: limits.maxCalls - counts.calls };
    };
    this.deps.registry.register({
      runId: input.runId,
      call: async (request) => {
        if (revoked) return refuse("revoked", "the code graph is no longer available to this run");
        const delegationId = this.deps.registry.delegationOf(request.sessionId);
        const leads = request.agent === CODE_GRAPH_LEAD_AGENT && delegationId === undefined;
        const explores = request.agent === CODE_GRAPH_EXPLORE_AGENT && delegationId !== undefined;
        if (!leads && !explores) return refuse("wrong-agent", "the code graph is available only to the lead and to its exploration");
        if (counts.calls >= limits.maxCalls) return refuse("no-calls", `this run's ${limits.maxCalls} code-graph calls are spent`);
        const share = explores ? (shares.get(delegationId) ?? { share: 0, used: 0 }) : undefined;
        if (share && share.used >= share.share) return refuse("no-calls", `the ${share.share} code-graph calls of this exploration are spent`);
        if (share) share.used += 1;
        counts.calls += 1;
        return inRunContext(() =>
          traceToolCall(
            this.deps.trace,
            { span: "qayaba.tool.codegraph", tool: `codegraph_${request.query.action}`, sessionId: request.sessionId, messageId: request.messageId },
            (observer) => serve(request, observer),
            (answer) => ({ "qayaba.tool.outcome": answer.ok ? "ok" : answer.code }),
          ),
        );
      },
    });
    return {
      limits,
      signals: () => ({ ...counts }),
      grantShare: (delegationId, calls) => {
        shares.set(delegationId, { share: Math.max(0, Math.min(Math.floor(calls), limits.maxCalls - counts.calls)), used: 0 });
      },
      close: () => {
        revoked = true;
        this.deps.registry.unregister(input.runId);
      },
    };
  }
}
