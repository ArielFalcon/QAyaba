/*
 * What a tool call pointed at, and whether the runtime refused it. Pure: the input a call carried in,
 * a labelled subject out. The tracker that sees the calls resolves paths, redacts and caps what this
 * names; nothing a call typed, wrote or sent as a body is ever a subject.
 */
import { TOOL_PATH_KEYS, toolInputPath } from "./tool-call-taxonomy.ts";

/** The longest tool sequence one turn keeps; calls beyond it are counted, not listed. */
export const TOOL_SEQUENCE_MAX_ENTRIES = 200;
/** The longest target one entry keeps, after redaction. */
export const TOOL_TARGET_MAX_CHARS = 200;

/** One call of a turn, in the order the agent made it. `target` is null when the call points at nothing; `scope` is the path a search ran in; `denied` marks a call the runtime refused. */
export interface ToolSequenceEntry {
  tool: string;
  target: string | null;
  scope?: string;
  /** For a content read: the part of the file it asked for (`readWindowOf`); absent for the whole file. */
  window?: string;
  denied?: true;
}

export type ToolSubjectKind = "path" | "pattern" | "url" | "command" | "query" | "element";

export interface ToolCallSubject {
  kind: ToolSubjectKind;
  value: string;
  /** The path a search was scoped to (kind `pattern` only). */
  scope?: string;
}

/* The input keys searches carry their pattern under: the native grep/glob `pattern` and Serena's search arguments. */
const PATTERN_KEYS = ["pattern", "substring_pattern", "name_path_pattern", "name_path"] as const;
const COMMAND_KEYS = ["command", "cmd"] as const;

function stringUnder(record: Record<string, unknown> | null | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/**
 * The one thing a call pointed at, by the keys its input carries: a search's pattern (scoped to the path it
 * searched in), a file path, a url, a command line, a memory query, or the element a browser call names.
 * Undefined when the input names none of them. Content, text and bodies are deliberately not read.
 */
export function toolCallSubject(input: unknown): ToolCallSubject | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;

  const pattern = stringUnder(record, PATTERN_KEYS);
  if (pattern !== undefined) {
    const scope = toolInputPath(record);
    return { kind: "pattern", value: pattern, ...(scope !== undefined ? { scope } : {}) };
  }
  const path = stringUnder(record, TOOL_PATH_KEYS);
  if (path !== undefined) return { kind: "path", value: path };
  const url = stringUnder(record, ["url"]);
  if (url !== undefined) return { kind: "url", value: url };
  const command = stringUnder(record, COMMAND_KEYS);
  if (command !== undefined) return { kind: "command", value: command };
  const query = stringUnder(record, ["query"]);
  if (query !== undefined) return { kind: "query", value: query };
  const element = stringUnder(record, ["element"]);
  return element !== undefined ? { kind: "element", value: element } : undefined;
}

/* The message the runtime attaches to a call a permission rule refuses (the pinned OpenCode build's own wording). A rejection by a person, or any other failure of a tool, is not this. */
const DENIAL_MESSAGE = /specified a rule which prevents you from using this specific tool call/i;

/** Whether a failed call's error text is the runtime refusing the call under a permission rule. */
export function isPermissionDenial(error: unknown): boolean {
  return typeof error === "string" && DENIAL_MESSAGE.test(error);
}
