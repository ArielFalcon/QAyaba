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
import { CODE_GRAPH_AGENT, DEFAULT_CODE_GRAPH_TOOL_LIMITS, type CodeGraphToolLimits } from "@kernel/code-graph-tools.ts";
import { err } from "@kernel/result.ts";
import type { CodeExplorePort } from "@kernel/ports/code-explore.port.ts";
import type { CodeGraphToolRequest, CodeGraphToolResponse } from "../../domain/code-graph-query.ts";
import type { CodeGraphToolsHandle, CodeGraphToolsOpenInput, CodeGraphToolsPort } from "../../application/ports/index.ts";
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
        if (request.agent !== CODE_GRAPH_AGENT) return refuse("wrong-agent", "the code graph is available only to the lead");
        if (counts.calls >= limits.maxCalls) return refuse("no-calls", `this run's ${limits.maxCalls} code-graph calls are spent`);
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

/* How big a text is for the budget: characters by default, bytes for a caller whose budget is in bytes. */
export type Size = (text: string) => number;

interface Omitted {
  /* Files not shown at all. */
  files: number;
  /* The last file shown is cut inside its code block. */
  partial: boolean;
  /* The closing sections (the engine's list of names not shown) are left out. */
  closing: boolean;
}

function omissionMarker(o: Omitted): string {
  const what = [
    ...(o.partial ? ["the rest of the last file shown"] : []),
    ...(o.files > 0 ? [`${o.files} more file${o.files === 1 ? "" : "s"}`] : []),
    ...(o.closing ? ["the closing notes"] : []),
  ];
  return what.length > 0 ? `[omitted: ${what.join(", ")} that did not fit; explore narrower terms to see more]` : "[omitted: the answer did not fit; explore narrower terms]";
}

/* The generic marker cut to `max` by the same measure as the budget. */
function fitMarker(max: number, size: Size): string {
  let marker = omissionMarker({ files: 0, partial: false, closing: false });
  while (marker.length > 0 && size(marker) > max) marker = marker.slice(0, -1);
  return marker;
}

/* The leading lines of one file section that fit in `room` characters, ending inside its code block at a line boundary with the block closed; undefined when not even one line of code fits. */
function cutFile(body: string, room: number, size: Size): string | undefined {
  const lines = body.split("\n");
  let out = "";
  let open: boolean = false;
  let code = 0;
  for (const line of lines) {
    const next = out === "" ? line : `${out}\n${line}`;
    const opens: boolean = FENCE.test(line) ? !open : open;
    if (size(next) + (opens ? size("\n```") : 0) > room) break;
    out = next;
    open = opens;
    if (open && !FENCE.test(line)) code += 1;
  }
  if (code === 0) return undefined;
  return open ? `${out}\n\`\`\`` : out;
}

/*
 * The engine's text as the lead is shown it: redacted as text first (a secret can sit anywhere in it, and the run's redaction
 * knows its values and patterns), then at most `max` characters. The opening (before the first file) is kept whole, then as many
 * whole files as fit, each from its heading to the next; the first file that does not fit is cut at a line boundary inside its
 * code block (the block is closed), so one large file never leaves the lead without source. The closing sections (the list of
 * names not shown) are kept when they fit after the source. What is left out is said in a closing marker that counts only what
 * is not shown. An opening that does not fit leaves only the marker.
 */
export function shapeExploreAnswer(text: string, max: number, redact?: (text: string) => string, size: Size = (t) => t.length): { result: string; truncated: boolean } {
  const clean = (redact ? redact(text) : text).trim();
  if (size(clean) <= max) return { result: clean, truncated: false };
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
  const closing = (firstFile === -1 ? [] : sections.slice(lastFile + 1)).map((s) => s.body.trim()).join("\n\n");
  let kept = opening.map((s) => s.body).join("\n").trim();
  const marker = (o: Omitted) => `\n\n${omissionMarker(o)}`;
  if (size(kept) + size(marker({ files: files.length, partial: false, closing: closing !== "" })) > max) return { result: fitMarker(max, size), truncated: true };
  let taken = 0;
  let partial = false;
  for (const file of files) {
    const body = file.body.trim();
    const rest = files.length - taken - 1;
    const whole = `${kept}\n\n${body}`;
    if (size(whole) + size(marker({ files: rest, partial: false, closing: closing !== "" })) <= max) {
      kept = whole;
      taken += 1;
      continue;
    }
    const room = max - size(kept) - 2 - size(marker({ files: rest, partial: true, closing: closing !== "" }));
    /* The closing list is worth a few lines of the cut file, but never the file's first line of code. */
    const cut = cutFile(body, room - (closing === "" ? 0 : size(closing) + 2), size) ?? cutFile(body, room, size);
    if (cut !== undefined) {
      kept = `${kept}\n\n${cut}`;
      taken += 1;
      partial = true;
    }
    break;
  }
  const left = files.length - taken;
  const withClosing = closing === "" ? undefined : `${kept}\n\n${closing}`;
  const closingFits = withClosing !== undefined && size(withClosing) + (left > 0 || partial ? size(marker({ files: left, partial, closing: false })) : 0) <= max;
  if (closingFits) kept = withClosing;
  const omitted: Omitted = { files: left, partial, closing: closing !== "" && !closingFits };
  if (omitted.files === 0 && !omitted.partial && !omitted.closing) return { result: kept, truncated: false };
  return { result: `${kept}${marker(omitted)}`, truncated: true };
}
