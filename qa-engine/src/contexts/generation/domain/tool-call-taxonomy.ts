/*
 * Pure tool-call taxonomy shared by the fine (in-session SSE) and coarse
 * (post-hoc run_events) classifiers, so counts derived from either path
 * reconcile by construction.
 *
 * `kindForTool` and its three regexes are ported VERBATIM from
 * `infrastructure/sse/agent-activity.ts` — that module now imports from here
 * instead of redefining them, so there is exactly one source of truth for
 * the coarse write/command/subagent/analyzing split.
 */

export type ActivityKind = "analyzing" | "writing" | "command" | "subagent";

export type CallBucket =
  | "code_read"
  | "browser"
  | "write"
  | "validate_run"
  | "memory"
  | "subagent"
  | "other";

export const CALL_BUCKETS = {
  CODE_READ: "code_read",
  BROWSER: "browser",
  WRITE: "write",
  VALIDATE_RUN: "validate_run",
  MEMORY: "memory",
  SUBAGENT: "subagent",
  OTHER: "other",
} as const satisfies Record<string, CallBucket>;

const WRITE_TOOLS = /^(write|edit|multiedit|create|apply_patch|patch)$/i;
const SHELL_TOOLS = /^(bash|shell|run|exec)$/i;
const SUBAGENT_TOOLS = /^(task|agent|subtask|dispatch)$/i;

export function kindForTool(tool: string): ActivityKind {
  if (WRITE_TOOLS.test(tool)) return "writing";
  if (SHELL_TOOLS.test(tool)) return "command";
  if (SUBAGENT_TOOLS.test(tool)) return "subagent";
  return "analyzing";
}

/* MCP tools reach the agent as `<server>_<tool>` (e.g. playwright_browser_navigate,
   mcp__playwright__browser_snapshot), so every fine pattern below tolerates a
   server prefix ending in `_`. Native tools (read, grep, …) carry none. */

/* Playwright MCP tools are all named browser_* (agents/opencode.json's qa-reviewer
   permission block enumerates the full set: browser_navigate, browser_snapshot, …). */
const BROWSER_TOOLS = /(^|_)browser_/i;

/* Cross-session recall: engram's MCP tools (mem_search, mem_save, mem_get_observation, …)
   and Serena's own project-memory tools (read_memory, write_memory, list_memories,
   delete_memory) are semantically the same bucket — the agent is recalling or
   persisting context rather than reading the working tree. */
const MEMORY_TOOLS = /(^|_)mem_|_memor(y|ies)$/i;

/* The native `read` tool plus Serena's code-navigation/search tools. */
const CODE_READ_TOOLS =
  /(^|_)(read|grep|glob|activate_project|find_referencing_symbols|find_symbol|get_symbols_overview|read_file|search_for_pattern|find_file|list_dir)$/i;

/**
 * Refines the coarse `analyzing` kind into `code_read` / `browser` / `memory` / `other`;
 * `writing`, `command` and `subagent` map one-to-one onto `write`,
 * `validate_run` and `subagent` so those three counts always reconcile with
 * `kindForTool`'s coarse classification.
 */
export function bucketForTool(tool: string): CallBucket {
  const kind = kindForTool(tool);
  if (kind === "writing") return CALL_BUCKETS.WRITE;
  if (kind === "command") return CALL_BUCKETS.VALIDATE_RUN;
  if (kind === "subagent") return CALL_BUCKETS.SUBAGENT;

  if (BROWSER_TOOLS.test(tool)) return CALL_BUCKETS.BROWSER;
  if (MEMORY_TOOLS.test(tool)) return CALL_BUCKETS.MEMORY;
  if (CODE_READ_TOOLS.test(tool)) return CALL_BUCKETS.CODE_READ;
  return CALL_BUCKETS.OTHER;
}
