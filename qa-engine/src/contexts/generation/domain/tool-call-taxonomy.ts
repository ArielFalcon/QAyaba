/*
 * Pure tool-call taxonomy shared by the fine (in-session SSE) and coarse
 * (post-hoc run_events) classifiers, so counts derived from either path
 * reconcile by construction.
 *
 * `kindForTool` classifies a raw tool name into the kind carried by the
 * `agent.activity` run event; `activity-mapper.ts` maps every tool event through it.
 * `isWriteTool` and `isShellTool` are its two predicates. The older activity
 * router (`infrastructure/sse/agent-activity.ts`, whose own 5-value `ActivityKind`
 * feeds the TUI activity list) asks the same predicates, so there is one
 * definition of which tools write and which run commands.
 */

/** The kind of an `agent.activity` run event; the same four values as `AgentActivityKindSchema` in the run-event contract. */
export type AgentActivityKind = "analyzing" | "writing" | "command" | "subagent";

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

/* Serena's tools that change the working tree (whole-file, symbol, line and regex edits, renames) and
   its shell tool. Like every MCP tool they may arrive as `<server>_<tool>`, so the server prefix is
   tolerated. Serena's memory tools (write_memory, …) are not here: they never touch the tree. */
const SERENA_WRITE_TOOLS =
  /(^|_)(create_text_file|replace_symbol_body|insert_after_symbol|insert_before_symbol|replace_content|replace_regex|replace_lines|delete_lines|insert_at_line|rename_symbol)$/i;
const SERENA_SHELL_TOOLS = /(^|_)execute_shell_command$/i;

export function isWriteTool(tool: string): boolean {
  return WRITE_TOOLS.test(tool) || SERENA_WRITE_TOOLS.test(tool);
}

export function isShellTool(tool: string): boolean {
  return SHELL_TOOLS.test(tool) || SERENA_SHELL_TOOLS.test(tool);
}

/* The input keys tools use for the file they touch: the native tools' `filePath`, `path`, `file` and `filename`, and Serena's `relative_path`. The one list every classifier reads, so a file touched through any of these tools is seen by all of them. */
export const TOOL_PATH_KEYS = ["filePath", "path", "file", "filename", "relative_path"] as const;

/** The file a tool call names in its input, as written (not resolved); undefined when it names none. */
export function toolInputPath(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of TOOL_PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export function kindForTool(tool: string): AgentActivityKind {
  if (isWriteTool(tool)) return "writing";
  if (isShellTool(tool)) return "command";
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
