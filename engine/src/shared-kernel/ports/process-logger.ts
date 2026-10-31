/* The logger engine code writes through. The engine never imports the shell, so the composition root installs the process's LoggerPort (the redacting one) once at boot; `engineLog` forwards to whatever is installed at the moment of the call, so a module needs no logger handed down and a test sees the same lines the port would. A process that installs none (a script, a test) gets the console, with the values of a line's fields after the message. */

import type { LogFields, LoggerPort, LogLevel } from "@kernel/ports/logger.port.ts";

const CONSOLE_METHOD = { debug: "debug", info: "log", warn: "warn", error: "error" } as const satisfies Record<LogLevel, "debug" | "log" | "warn" | "error">;

function consoleLogger(bound: LogFields): LoggerPort {
  const write = (level: LogLevel) => (message: string, fields?: LogFields): void => {
    const { ship: _routing, ...shown } = { ...bound, ...fields };
    console[CONSOLE_METHOD[level]](message, ...Object.values(shown));
  };
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error"), child: (more) => consoleLogger({ ...bound, ...more }) };
}

let installed: LoggerPort | undefined;

/* Called once by the composition root of a process that wants the engine's lines redacted and structured. */
export function installProcessLogger(logger: LoggerPort): void {
  installed = logger;
}

export function resetProcessLoggerForTests(): void {
  installed = undefined;
}

function forwarding(bound: LogFields): LoggerPort {
  const current = (): LoggerPort => {
    const base = installed ?? consoleLogger({});
    return Object.keys(bound).length === 0 ? base : base.child(bound);
  };
  return {
    debug: (message, fields) => current().debug(message, fields),
    info: (message, fields) => current().info(message, fields),
    warn: (message, fields) => current().warn(message, fields),
    error: (message, fields) => current().error(message, fields),
    child: (more) => forwarding({ ...bound, ...more }),
  };
}

export const engineLog: LoggerPort = forwarding({});
