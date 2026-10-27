import { logJson, type LogLevel } from "./logger";
import { RedactionPortAdapter } from "../orchestrator/sanitizer";
import type { LogFields, LoggerPort } from "../../qa-engine/src/shared-kernel/ports/logger.port";
import type { RedactionPort } from "../../qa-engine/src/shared-kernel/ports/redaction.port";

/*
 * The shell's LoggerPort. A line is redacted before it is handed to the JSON logger, so the rotating file, the console
 * mirror and the log shipper (below) all receive redacted text: the message and every string in the fields go
 * through the redaction port (the orchestrator's environment secrets and the secret patterns by value, and the run's own
 * account secrets when a run's scope is active). A redaction that throws drops the line: one fallback line says so, and
 * the raw text is never written.
 */

export type LogSink = (level: LogLevel, message: string, meta?: Record<string, unknown>, mirrorToConsole?: boolean) => void;

export interface RedactingLoggerDeps {
  /* Where a redacted line goes. Default: the process JSON logger. */
  readonly sink?: LogSink;
  /* Built per line, so a settings reload reaches the secrets it redacts by value. Default: the shell's redaction. */
  readonly redactor?: () => Pick<RedactionPort, "redact">;
  readonly fields?: LogFields;
}

/* Deeper structure than this is not walked: it is replaced by a marker, never logged raw. */
const MAX_FIELD_DEPTH = 4;
const TRUNCATED = "[truncated]";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* Redacts every string reachable from a field value; an Error becomes its redacted message. */
function redactValue(value: unknown, redact: (text: string) => string, depth: number): unknown {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return redact(errorMessage(value));
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value instanceof URL) return redact(value.href);
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (depth >= MAX_FIELD_DEPTH) return TRUNCATED;
  if (value instanceof Map) return [...value].map(([key, inner]) => [redactValue(key, redact, depth + 1), redactValue(inner, redact, depth + 1)]);
  if (value instanceof Set) return [...value].map((inner) => redactValue(inner, redact, depth + 1));
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) out[redact(key)] = redactValue(inner, redact, depth + 1);
  return out;
}

function redactFields(level: LogLevel, fields: LogFields, redact: (text: string) => string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key !== "error") {
      out[key] = redactValue(value, redact, 0);
      continue;
    }
    /* A thrown value is rendered as its message; a structure someone put in the field keeps its shape. */
    out.error = typeof value === "object" && value !== null && !(value instanceof Error) ? redactValue(value, redact, 0) : redact(errorMessage(value));
    if (level === "debug" && value instanceof Error && value.stack) out.stack = redact(value.stack);
  }
  return out;
}

/* A line that was redacted and is to leave the process for the log store. */
export interface ShippedLine {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}
export type LogShipper = (line: ShippedLine) => void;

let shipper: LogShipper | undefined;

/* The telemetry bootstrap installs the one shipper that turns a redacted line into a log record joined to its run; undefined removes it. */
export function installLogShipper(next: LogShipper | undefined): void {
  shipper = next;
}

/* Which lines leave for the log store. Tempo holds what happened, as structured spans; the store holds how it happened.
   A warning or an error is always how (something went off the expected path). An info or debug line is shipped only when
   its call site says so with `ship: true`: it explains something no span records. `ship: false` withholds a warning that
   only restates a span fact. The field is a routing flag: it is consumed here and never written to the line. */
function shipsToStore(level: LogLevel, flag: unknown): boolean {
  if (typeof flag === "boolean") return flag;
  return level === "warn" || level === "error";
}

export function createRedactingLogger(deps: RedactingLoggerDeps = {}): LoggerPort {
  const sink = deps.sink ?? logJson;
  const redactor = deps.redactor ?? ((): Pick<RedactionPort, "redact"> => new RedactionPortAdapter());
  const bound = deps.fields ?? {};

  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    let safeMessage: string;
    let safeFields: Record<string, unknown>;
    const { ship, ...rest } = { ...bound, ...fields } as Record<string, unknown>;
    try {
      const port = redactor();
      const redact = (text: string): string => port.redact(text);
      safeMessage = redact(message);
      safeFields = redactFields(level, rest, redact);
    } catch {
      sink("error", "[logger] redaction failed; a log line was dropped");
      return;
    }
    if (shipper !== undefined && shipsToStore(level, ship)) {
      try {
        shipper({ level, message: safeMessage, fields: safeFields });
      } catch {
        /* Shipping a line never breaks the caller. */
      }
    }
    /* Debug lines go to the shipped file only, as the per-run sinks do: the console stays the operator's view. */
    if (level === "debug") sink(level, safeMessage, safeFields, false);
    else sink(level, safeMessage, safeFields);
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (more) => createRedactingLogger({ ...deps, fields: { ...bound, ...more } }),
  };
}

/* The process logger every shell module without its own dependency seam logs through. */
export const appLogger: LoggerPort = createRedactingLogger();

/* The sink a dependency takes as `log: (level, message, meta) => void`: the process logger, level by level. */
export const logLine = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => appLogger[level](message, meta);
