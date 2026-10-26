/* The process's graceful shutdown: one pair of signal handlers (SIGTERM and SIGINT) that cancel the in-flight run, wait for it to unwind, flush telemetry and exit. There is exactly one shutdown path: two handlers for one signal raced (two drain timers, two exits) and made `docker stop` non-deterministic. The database is closed by the exit hook that openHistoryDatabase registers. */

export interface ShutdownDeps {
  queue: { cancel(): void; drain(): Promise<void> };
  telemetry: {
    /* Synchronous: commits the buffered span ledger rows before the process is cut. */
    flush(): void;
    shutdown(timeoutMs: number): Promise<void>;
  };
  hostHealth: { stop(): void };
  /* The agent runtime's live event stream, ended so no reconnect loop outlives the drain. */
  eventStream: { abort(): void };
  /* How long the cancelled run gets to unwind before the process is cut with exit code 1. */
  drainMs: number;
  /* Bounds the final flush and stop of the telemetry exporters on a clean exit. */
  telemetryShutdownMs: number;
  exit(code: number): void;
  log(message: string): void;
}

export interface SignalSource {
  on(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

export interface Lifecycle {
  /* True once a shutdown began, or once something (the maintainer's hot swap) marked the process as going away: new work is refused. */
  shuttingDown(): boolean;
  setShuttingDown(value: boolean): void;
  /* Runs the shutdown for a signal and resolves after `exit` was called. A second call while one runs joins it. */
  shutdown(signal: string): Promise<void>;
}

/* Registers the one SIGTERM/SIGINT pair on `signals` and returns the lifecycle that the rest of the process asks. */
export function installShutdown(deps: ShutdownDeps, signals: SignalSource = process): Lifecycle {
  let refusing = false;
  let running: Promise<void> | undefined;

  function shutdown(signal: string): Promise<void> {
    if (running) return running;
    deps.log(`[qa] ${signal} received — cancelling in-flight run and draining`);
    refusing = true;
    deps.hostHealth.stop();
    deps.eventStream.abort();

    /* Abort the in-flight job's signal so the pipeline's checkSignal() unwinds deterministically and teardown runs before exit. */
    deps.queue.cancel();

    running = new Promise<void>((resolve) => {
      /* If the unwind takes too long, force the exit so the orchestrator never hangs the host process. */
      const drainTimer = setTimeout(() => {
        deps.log("[qa] shutdown timeout — forcing exit");
        deps.telemetry.flush();
        deps.exit(1);
        resolve();
      }, deps.drainMs);
      void deps.queue.drain().finally(async () => {
        clearTimeout(drainTimer);
        deps.log("[qa] drained — exiting");
        await deps.telemetry.shutdown(deps.telemetryShutdownMs);
        deps.exit(0);
        resolve();
      });
    });
    return running;
  }

  signals.on("SIGTERM", () => void shutdown("SIGTERM"));
  signals.on("SIGINT", () => void shutdown("SIGINT"));

  return {
    shuttingDown: () => refusing,
    setShuttingDown: (value) => {
      refusing = value;
    },
    shutdown,
  };
}

/* Records an unhandled rejection as an incident instead of letting it vanish; the process keeps running. */
export function installUnhandledRejectionRecorder(
  record: (summary: string) => void,
  logError: (message: string) => void,
  source: { on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown } = process,
): void {
  source.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    logError(`[qa] unhandled rejection: ${reason instanceof Error ? reason.stack ?? message : message}`);
    record(`unhandled rejection: ${message}`);
  });
}
