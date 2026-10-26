/*
 * The lead's read-only code-graph tool for one run. The graph is the orchestrator's (its engine and its stores live in the
 * orchestrator only, and a store holds a repo's code), so the lead never reaches it: it asks through the tools endpoint and the
 * orchestrator answers over the index the run built, for each repo of the run's change (the orchestrator's own list, named by
 * the configuration, never by the caller), inside the run's scope, under the run's limits. One call asks every repo the same
 * terms, splits the file and character budgets among them and labels each section with its repo; a repo whose index cannot
 * answer is named as unavailable and the others still answer. A run
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
  /* The repositories of the run's change, each with the mirror its index was built from: primary and services as the configuration declares them. */
  repos: ReadonlyArray<{ repo: string; repoDir: string }>;
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
    const { repos } = this.deps;
    const serve = async (request: CodeGraphToolRequest, observer: ToolObserver): Promise<CodeGraphToolResponse> => {
      /*
       * The file and character budgets are the run's, shared by the repos; one repo keeps them whole. With more repos than
       * files, the first ones get a file each and the rest are not asked, so the files asked never exceed the budget.
       */
      const asked = repos.slice(0, Math.max(1, limits.maxFiles));
      const notAsked = repos.slice(asked.length);
      const maxFiles = Math.max(1, Math.floor(limits.maxFiles / asked.length));
      const label = (repo: string): string => `## Repository ${repo}\n`;
      const notAskedSections = notAsked.map(({ repo }) => `${label(repo)}[not asked: the run's file budget went to the repositories above]`);
      /* Labels, separators and the not-asked sections come out of the character budget first; the rest is shared. */
      const overhead = asked.reduce((n, { repo }) => n + label(repo).length, 0) + notAskedSections.reduce((n, t) => n + t.length, 0) + 2 * (repos.length - 1);
      const maxChars = Math.max(0, Math.floor((limits.maxAnswerChars - overhead) / asked.length));
      const answers = await Promise.all(
        asked.map(async ({ repo, repoDir }) => ({
          repo,
          answer: await this.deps.explore.explore(repoDir, request.query.terms, maxFiles).catch((cause: unknown) => err({ reason: cause instanceof Error ? cause.message : String(cause) })),
        })),
      );
      const answered = answers.filter((a) => a.answer.ok);
      for (const { repo, answer } of answers) {
        if (answer.ok) continue;
        const reason = failureReason(answer.error.reason, this.deps.redact);
        console.error(`[qa] code-graph explore failed for run ${input.runId}${repos.length > 1 ? ` in ${repo}` : ""}: ${reason}`);
        observer.setAttrs({ "qayaba.code_graph.reason": reason });
      }
      if (answered.length === 0) {
        counts.failed += 1;
        return { ok: false, code: "failed", message: "the code graph could not answer this query; try other names (a symbol, a file path or a short code term)" };
      }
      const first = answered[0]!.answer;
      if (!first.ok) throw new Error("unreachable: an answered repo holds an answer");
      observer.setAttrs({ "qayaba.code_graph.sha": first.value.indexedSha });
      if (repos.length === 1) {
        const { result, truncated } = shapeExploreAnswer(first.value.text, limits.maxAnswerChars, this.deps.redact);
        return { ok: true, result, truncated, indexedSha: first.value.indexedSha, callsLeft: limits.maxCalls - counts.calls };
      }
      let truncated = false;
      const sections = answers.map(({ repo, answer }) => {
        if (!answer.ok) return `${label(repo)}${"[unavailable: the code graph could not answer for this repository]".slice(0, maxChars)}`;
        const shaped = shapeExploreAnswer(answer.value.text, maxChars, this.deps.redact);
        truncated ||= shaped.truncated;
        return `${label(repo)}${shaped.result}`;
      });
      truncated ||= notAsked.length > 0;
      return { ok: true, result: [...sections, ...notAskedSections].join("\n\n"), truncated, indexedSha: first.value.indexedSha, callsLeft: limits.maxCalls - counts.calls };
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
