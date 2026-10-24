/*
 * The lead's read-only code-graph tools for one run. The graph is the orchestrator's (its CLI and its store live in the
 * orchestrator only, and the store holds every app's code), so the lead never reaches it: it asks through the tools endpoint and
 * the orchestrator runs the query on the run's own project, resolved here from the app's mirror, inside the run's scope, under
 * the run's limits. A run whose app is not in the graph, or whose lead runs on a runtime that cannot call a custom tool, is
 * granted nothing. The answer is the graph's JSON, redacted value by value (a secret inside a JSON string is escaped there, so
 * the text alone would hide it from a redaction by value) and cut by its structure to a size the prompt can take, so what the
 * lead reads is still JSON; a query the graph cannot answer is a failed call, with nothing of the CLI's own output.
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
      const { result, truncated } = shapeAnswer(stdout, limits.maxAnswerChars, this.deps.redact);
      return { ok: true, result, truncated, callsLeft: limits.maxCalls - counts.calls };
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

const CUT_MARK = " … (cut)";
/* A bound on the cutting passes: each one drops an entry or halves a string, so an answer of any size fits well within it. */
const MAX_CUT_PASSES = 10_000;

/* Every string of a JSON value, keys included, through the redaction. */
function redactJson(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, redact));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactJson(item, redact)]));
  return value;
}

/* The longest array with entries left, or failing that the longest string, anywhere in the value: what the next pass cuts. */
function largest(value: unknown): { array?: unknown[]; holder?: Record<string, unknown> | unknown[]; key?: string | number; length: number } {
  let best: { array?: unknown[]; holder?: Record<string, unknown> | unknown[]; key?: string | number; length: number } = { length: 0 };
  let bestString: typeof best = { length: 0 };
  const visit = (node: unknown, holder?: Record<string, unknown> | unknown[], key?: string | number): void => {
    if (typeof node === "string" && holder !== undefined && node.length > bestString.length) bestString = { holder, key: key!, length: node.length };
    if (Array.isArray(node)) {
      if (node.length > 0 && node.length >= best.length) best = { array: node, length: node.length };
      node.forEach((item, i) => visit(item, node, i));
    } else if (node && typeof node === "object") {
      for (const [k, item] of Object.entries(node)) visit(item, node as Record<string, unknown>, k);
    }
  };
  visit(value);
  return best.array && best.length > 1 ? best : bestString.length > CUT_MARK.length * 2 ? bestString : best;
}

/*
 * The graph's answer as the lead is shown it: redacted, and at most `max` characters. A JSON answer stays JSON: its longest
 * list loses entries from its end, then its longest string is halved, until it fits. An answer that is not JSON is redacted
 * and cut as text.
 */
export function shapeAnswer(stdout: string, max: number, redact?: (text: string) => string): { result: string; truncated: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const clean = redact ? redact(stdout) : stdout;
    return clean.length > max ? { result: clean.slice(0, max), truncated: true } : { result: clean, truncated: false };
  }
  const value = redact ? redactJson(parsed, redact) : parsed;
  let text = JSON.stringify(value);
  let truncated = false;
  for (let pass = 0; text.length > max && pass < MAX_CUT_PASSES; pass++) {
    const target = largest(value);
    if (target.array && target.array.length > 1) target.array.pop();
    else if (target.holder !== undefined && target.key !== undefined) {
      const current = (target.holder as Record<string | number, unknown>)[target.key] as string;
      (target.holder as Record<string | number, unknown>)[target.key] = `${current.slice(0, Math.floor(current.length / 2))}${CUT_MARK}`;
    } else if (target.array) target.array.pop();
    else break;
    truncated = true;
    text = JSON.stringify(value);
  }
  /* A value nothing more can be cut from (a single long key, say) is cut as text: never more than the lead's share. */
  return text.length > max ? { result: text.slice(0, max), truncated: true } : { result: text, truncated };
}
