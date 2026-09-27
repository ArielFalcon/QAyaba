import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";

/* JSON-structured logger: a single stream so logs ship without interleaving stdout noise. */

const LOG_DIR = join(process.env.QAYABA_ROOT ?? process.cwd(), "data", "logs");
const MAX_LOG_FILES = 5;
const MAX_LOG_BYTES = 50 * 1024 * 1024;

type LogLevel = "info" | "warn" | "error";

export interface JsonLoggerOptions {
  dir: string;
  maxFiles: number;
  /* The active file rotates before a write would take it past this size; a single larger line gets a file of its own. */
  maxBytes?: number;
  now?: () => Date;
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

export function createJsonLogger({
  dir,
  maxFiles,
  maxBytes = MAX_LOG_BYTES,
  now = () => new Date(),
}: JsonLoggerOptions): JsonLogger {
  let stream: WriteStream | null = null;
  /* Counted in memory: the stream flushes asynchronously, so a stat of the file lags what was written. */
  let bytes = 0;
  const draining = new Set<Promise<void>>();

  function openStream(): WriteStream {
    mkdirSync(dir, { recursive: true });
    const timestamp = now().toISOString().replace(/[:.]/g, "-");
    const file = `app-${timestamp}.log`;
    const opened = createWriteStream(join(dir, file), { flags: "a" });
    opened.on("error", (err) => {
      console.error("[logger] write failed:", err.message);
    });
    bytes = 0;
    pruneOldLogs(file);
    return opened;
  }

  function ensureStream(lineBytes: number): WriteStream {
    if (!stream || stream.destroyed) {
      stream = openStream();
    } else if (bytes > 0 && bytes + lineBytes > maxBytes) {
      rotate(stream);
    }
    return stream;
  }

  /* Fail-open: when the next file cannot be opened, keep writing to the current one and retry only
     after another maxBytes, so a persistent failure neither breaks logging nor floods stderr. */
  function rotate(current: WriteStream): void {
    try {
      stream = openStream();
    } catch (err) {
      console.error("[logger] rotation failed, continuing on the current file:", (err as Error).message);
      bytes = 0;
      return;
    }
    retire(current);
  }

  function retire(retired: WriteStream): void {
    const done: Promise<void> = finished(retired.end())
      .catch(() => {})
      .finally(() => draining.delete(done));
    draining.add(done);
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
        t: now().toISOString(),
        l: level,
        m: message,
        ...meta,
      };
      const line = JSON.stringify(entry) + "\n";
      const lineBytes = Buffer.byteLength(line);
      ensureStream(lineBytes).write(line);
      bytes += lineBytes;
      if (mirrorToConsole) {
        const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
        consoleFn(line.trimEnd());
      }
    },
    async close() {
      if (stream) retire(stream);
      stream = null;
      await Promise.all(draining);
    },
  };
}

const defaultLogger = createJsonLogger({ dir: LOG_DIR, maxFiles: MAX_LOG_FILES, maxBytes: MAX_LOG_BYTES });

export function logJson(
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
  /* false writes only to the shipped JSON file (the per-run sink already prints stdout). */
  mirrorToConsole = true,
): void {
  defaultLogger.logJson(level, message, meta, mirrorToConsole);
}
