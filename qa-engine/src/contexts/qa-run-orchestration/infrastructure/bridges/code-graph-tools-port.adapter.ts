/*
 * The lead's read-only code-graph tool for one run. The graph is the orchestrator's (its engine and its stores live in the
 * orchestrator only, and a store holds a repo's code), so the lead never reaches it: it asks through the tools endpoint and the
 * orchestrator answers over the index the run built, for the run's own repo, inside the run's scope, under the run's limits. A run
 * whose lead runs on a runtime that cannot call a custom tool is granted nothing. The answer is the engine's text, redacted as text
 * (by value and by pattern, the run's own redaction) and cut only between files, so no code block the lead reads is partial; a query
 * the index cannot answer is a failed call, with nothing of the engine's own reason.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { CODE_GRAPH_AGENT, DEFAULT_CODE_GRAPH_TOOL_LIMITS, type CodeGraphToolLimits } from "@kernel/code-graph-tools.ts";
import type { CodeExplorePort } from "@kernel/ports/code-explore.port.ts";
import type { CodeGraphToolRequest, CodeGraphToolResponse } from "../../domain/code-graph-query.ts";
import type { CodeGraphToolsHandle, CodeGraphToolsOpenInput, CodeGraphToolsPort } from "../../application/ports/index.ts";
import type { CodeGraphToolRegistry } from "../code-graph-tool-registry.ts";
import { traceToolCall, type ToolTraceWiring } from "./tool-call-trace.ts";

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

export class CodeGraphToolsPortAdapter implements CodeGraphToolsPort {
  constructor(private readonly deps: CodeGraphToolsPortAdapterDeps) {}

  async open(input: CodeGraphToolsOpenInput): Promise<CodeGraphToolsHandle | undefined> {
    if (!this.deps.generatorRuntimeCanCall()) return undefined;
    const limits = this.deps.limits ?? DEFAULT_CODE_GRAPH_TOOL_LIMITS;
    const counts = { calls: 0, refused: 0, failed: 0 };
    let revoked = false;
    /* The run's async context as it is now: its sandbox scope and its secret scope. Every call runs inside it. */
    const inRunContext = AsyncLocalStorage.snapshot();
    const refuse = (code: "wrong-agent" | "revoked" | "no-calls", message: string): CodeGraphToolResponse => {
      counts.refused += 1;
      return { ok: false, code, message };
    };
    const serve = async (request: CodeGraphToolRequest, observe: (indexedSha: string) => void): Promise<CodeGraphToolResponse> => {
      const answer = await this.deps.explore.explore(this.deps.repoDir, request.query.terms, limits.maxFiles);
      if (!answer.ok) {
        counts.failed += 1;
        return { ok: false, code: "failed", message: "the code graph could not answer this query; try other names (a symbol, a file path or a short code term)" };
      }
      observe(answer.value.indexedSha);
      const { result, truncated } = shapeExploreAnswer(answer.value.text, limits.maxAnswerChars, this.deps.redact);
      return { ok: true, result, truncated, indexedSha: answer.value.indexedSha, callsLeft: limits.maxCalls - counts.calls };
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
            (observer) => serve(request, (indexedSha) => observer.setAttrs({ "qayaba.code_graph.sha": indexedSha })),
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

/* A line the engine's text opens a section with, outside every code block: a file's heading (**`path`** — ...) or one of the answer's own headings. */
const SECTION = /^\*\*/;
const FILE_HEADING = /^\*\*`/;
const FENCE = /^```/;

function omissionMarker(files: number): string {
  return files > 0 ? `[omitted: ${files} more file${files === 1 ? "" : "s"} that did not fit; explore narrower terms to see ${files === 1 ? "it" : "them"}]` : "[omitted: the answer did not fit; explore narrower terms]";
}

/*
 * The engine's text as the lead is shown it: redacted as text first (a secret can sit anywhere in it, and the run's redaction
 * knows its values and patterns), then at most `max` characters. The text is cut only between its sections, never inside a code
 * block: the opening (before the first file) is kept whole, then as many whole files as fit, each from its heading to the next;
 * the closing list of names not shown is kept only when every file is. What is left out is said in a closing marker. An opening
 * that does not fit leaves only the marker.
 */
export function shapeExploreAnswer(text: string, max: number, redact?: (text: string) => string): { result: string; truncated: boolean } {
  const clean = (redact ? redact(text) : text).trim();
  if (clean.length <= max) return { result: clean, truncated: false };
  const sections: Array<{ file: boolean; body: string }> = [];
  let inBlock = false;
  for (const line of clean.split("\n")) {
    if (!inBlock && SECTION.test(line)) sections.push({ file: FILE_HEADING.test(line), body: line });
    else if (sections.length === 0) sections.push({ file: false, body: line });
    else sections[sections.length - 1]!.body += `\n${line}`;
    if (FENCE.test(line)) inBlock = !inBlock;
  }
  const firstFile = sections.findIndex((s) => s.file);
  const lastFile = sections.map((s) => s.file).lastIndexOf(true);
  /* The opening: every section before the first file. The closing: every section after the last. Without a file, the whole text is an opening. */
  const opening = sections.slice(0, firstFile === -1 ? sections.length : firstFile);
  const files = firstFile === -1 ? [] : sections.slice(firstFile, lastFile + 1);
  let kept = opening.map((s) => s.body).join("\n").trim();
  const marker = (omitted: number) => `\n\n${omissionMarker(omitted)}`;
  if (kept.length + marker(files.length).length > max) return { result: omissionMarker(0).slice(0, max), truncated: true };
  let taken = 0;
  for (const file of files) {
    const next = `${kept}\n\n${file.body.trim()}`;
    if (next.length + marker(files.length - taken - 1).length > max) break;
    kept = next;
    taken += 1;
  }
  return { result: `${kept}${marker(files.length - taken)}`, truncated: true };
}
