import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";

/* JSON-structured logger: a single stream so logs ship without interleaving stdout noise. */

const LOG_DIR = join(process.env.QAYABA_ROOT ?? process.cwd(), "data", "logs");
const MAX_LOG_FILES = 5;

type LogLevel = "info" | "warn" | "error";

export interface JsonLoggerOptions {
  dir: string;
  maxFiles: number;
}

export interface JsonLogger {
  logJson(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
    /* false writes only to the shipped JSON file (the per-run sink already prints stdout). */
    mirrorToConsole?: boolean,
  ): void;
  /* Ends the active stream and resolves once everything written so far is flushed. */
  close(): Promise<void>;
}

export function createJsonLogger({ dir, maxFiles }: JsonLoggerOptions): JsonLogger {
  let stream: WriteStream | null = null;

  function ensureStream(): WriteStream {
    if (stream && !stream.destroyed) return stream;
    mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = `app-${timestamp}.log`;
    stream = createWriteStream(join(dir, file), { flags: "a" });
    stream.on("error", (err) => {
      console.error("[logger] write failed:", err.message);
    });
    pruneOldLogs(file);
    return stream;
  }

  /* The active file is excluded and counted as one of maxFiles: it opens asynchronously, so it may
     not be on disk yet, and it must never be pruned out from under the live stream. */
  function pruneOldLogs(activeFile: string): void {
    try {
      const files = readdirSync(dir)
        .filter((f) => f !== activeFile && f.startsWith("app-") && f.endsWith(".log"))
        .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtime }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      for (const old of files.slice(Math.max(0, maxFiles - 1))) unlinkSync(old.path);
    } catch {
      /* ignore pruning errors */
    }
  }

  return {
    logJson(level, message, meta, mirrorToConsole = true) {
      const entry = {
        t: new Date().toISOString(),
        l: level,
        m: message,
        ...meta,
      };
      const line = JSON.stringify(entry) + "\n";
      ensureStream().write(line);
      if (mirrorToConsole) {
        const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
        consoleFn(line.trimEnd());
      }
    },
    async close() {
      if (!stream) return;
      const current = stream;
      stream = null;
      await finished(current.end()).catch(() => {});
    },
  };
}

const defaultLogger = createJsonLogger({ dir: LOG_DIR, maxFiles: MAX_LOG_FILES });

export function logJson(
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
  /* false writes only to the shipped JSON file (the per-run sink already prints stdout). */
  mirrorToConsole = true,
): void {
  defaultLogger.logJson(level, message, meta, mirrorToConsole);
}
