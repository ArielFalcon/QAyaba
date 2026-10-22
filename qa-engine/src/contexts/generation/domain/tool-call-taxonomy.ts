import { classifyShellCommand } from "./shell-command-class.ts";

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
  | "script_run"
  | "memory"
  | "subagent"
  | "other";

export const CALL_BUCKETS = {
  CODE_READ: "code_read",
  BROWSER: "browser",
  WRITE: "write",
  VALIDATE_RUN: "validate_run",
  SCRIPT_RUN: "script_run",
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
export const SERENA_WRITE_TOOL_NAMES: readonly string[] = [
  "create_text_file",
  "replace_symbol_body",
  "insert_after_symbol",
  "insert_before_symbol",
  "replace_content",
  "replace_regex",
  "replace_lines",
  "delete_lines",
  "insert_at_line",
  "rename_symbol",
];
const SERENA_WRITE_TOOLS = new RegExp(`(^|_)(${SERENA_WRITE_TOOL_NAMES.join("|")})$`, "i");
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
  /* A non-object input names no file; a lookup on it answers undefined. */
  const record = input as Record<string, unknown> | null | undefined;
  for (const key of TOOL_PATH_KEYS) {
    const value = record?.[key];
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

/* The input keys a shell tool carries its command line under: the native bash tool's `command`, Serena's `command`, and `cmd`. */
const SHELL_COMMAND_KEYS = ["command", "cmd"] as const;

function shellCommandOf(input: unknown): string | undefined {
  /* A non-object input carries no command; a lookup on it answers undefined. */
  const record = input as Record<string, unknown> | null | undefined;
  for (const key of SHELL_COMMAND_KEYS) {
    const value = record?.[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/* What a shell call was doing, by its command: orienting in the tree is a code read, checking the work is a validation, running a program is a script run. A command the classifier cannot vouch for, and a call with no command to read, is `other`. */
function bucketForShellCall(input: unknown): CallBucket {
  const command = shellCommandOf(input);
  if (command === undefined) return CALL_BUCKETS.OTHER;
  switch (classifyShellCommand(command)) {
    case "read": return CALL_BUCKETS.CODE_READ;
    case "validate": return CALL_BUCKETS.VALIDATE_RUN;
    case "script": return CALL_BUCKETS.SCRIPT_RUN;
    case "unknown": return CALL_BUCKETS.OTHER;
  }
}

/**
 * Refines the coarse `analyzing` kind into `code_read` / `browser` / `memory` / `other`, and the
 * `command` kind by the command line the call carries (`bucketForShellCall`); `writing` and
 * `subagent` map one-to-one onto `write` and `subagent`. The coarse classifier cannot see a
 * command line, so it buckets none of its `command` events: what both sides share is that a shell
 * call is a command (`isShellTool`), whatever bucket the fine side gives it.
 */
export function bucketForTool(tool: string, input?: unknown): CallBucket {
  const kind = kindForTool(tool);
  if (kind === "writing") return CALL_BUCKETS.WRITE;
  if (kind === "command") return bucketForShellCall(input);
  if (kind === "subagent") return CALL_BUCKETS.SUBAGENT;

  if (BROWSER_TOOLS.test(tool)) return CALL_BUCKETS.BROWSER;
  if (MEMORY_TOOLS.test(tool)) return CALL_BUCKETS.MEMORY;
  if (CODE_READ_TOOLS.test(tool)) return CALL_BUCKETS.CODE_READ;
  return CALL_BUCKETS.OTHER;
}
