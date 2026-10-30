/* The one seam production code logs through. An adapter redacts the message and every field before anything is written, so a caller never formats a secret or a raw error into a line by hand. */

export type LogLevel = "debug" | "info" | "warn" | "error";

/* What a fact did to the run. A line's level answers that one question, and the module that owns an outcome maps it to an effect: `ended` (the run ended or the process cannot do its job) is error, `carried-on` (the run went on past a fault or a loss) is warn, `expected` (nothing left the expected path) is info. */
export const LOG_EFFECT = { ENDED: "ended", CARRIED_ON: "carried-on", EXPECTED: "expected" } as const;
export type LogEffect = (typeof LOG_EFFECT)[keyof typeof LOG_EFFECT];

const LEVEL_OF_EFFECT = { ended: "error", "carried-on": "warn", expected: "info" } as const satisfies Record<LogEffect, LogLevel>;

export function levelOfEffect<E extends LogEffect>(effect: E): (typeof LEVEL_OF_EFFECT)[E] {
  return LEVEL_OF_EFFECT[effect];
}

/* Extra structured data of a line. A field named `error` accepts any thrown value: the adapter renders it as a redacted message (and its stack, redacted, at `debug`). */
export type LogFields = Readonly<Record<string, unknown>>;

/* Reserved field `ship`: routes a line to the log store (Loki), which holds how something happened and never repeats a fact a span records. warn and error ship by default; `ship: true` on an info line says it explains something no span records; `ship: false` withholds a warning that only restates a span fact. The adapter consumes it; it is never written to the line. */

export interface LoggerPort {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /* A logger that adds these fields to every line it writes. */
  child(fields: LogFields): LoggerPort;
}

/* For a test that does not care what is logged. */
export const silentLogger: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

export interface MemoryLogger extends LoggerPort {
  /* Every line written through this logger or a child of it, in order. */
  readonly entries: readonly LogEntry[];
}

/* For a test that asserts on what is logged: records instead of writing. */
export function memoryLogger(): MemoryLogger {
  const entries: LogEntry[] = [];
  const make = (bound: LogFields): LoggerPort => {
    const write = (level: LogLevel) => (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields: { ...bound, ...fields } });
    };
    return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error"), child: (more) => make({ ...bound, ...more }) };
  };
  return Object.assign(make({}), { entries });
}
