import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { qayabaDataDir } from "../paths";
import { finished } from "node:stream/promises";

/* JSON-structured logger: a single stream so logs ship without interleaving stdout noise. */

const LOG_DIR = process.env.QAYABA_LOG_DIR ?? join(qayabaDataDir(), "logs");
const MAX_LOG_FILES = 5;
const MAX_LOG_BYTES = 50 * 1024 * 1024;
/* A file of unknown or unreachable owner written this recently may still be some process's active file. */
const RECENT_WRITE_GRACE_MS = 60 * 60 * 1000;
/* app-<timestamp>-p<pid>.log; files from before the owner pid was recorded have no -p<pid>. */
const LOG_FILE_RE = /^app-.+?(?:-p(\d+))?\.log$/;

type LogLevel = "info" | "warn" | "error";

export interface JsonLoggerOptions {
  dir: string;
  maxFiles: number;
  /* The active file rotates before a write would take it past this size; a single larger line gets a file of its own. */
  maxBytes?: number;
  now?: () => Date;
  /* Recorded in each file name so other processes sharing the directory can tell whose file it is. */
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    /* EPERM: the process exists but belongs to another user. */
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function createJsonLogger({
  dir,
  maxFiles,
  maxBytes = MAX_LOG_BYTES,
  now = () => new Date(),
  pid = process.pid,
  isProcessAlive = processIsAlive,
}: JsonLoggerOptions): JsonLogger {
  let stream: WriteStream | null = null;
  /* Counted in memory: the stream flushes asynchronously, so a stat of the file lags what was written. */
  let bytes = 0;
  const draining = new Set<Promise<void>>();

  function openStream(): WriteStream {
    mkdirSync(dir, { recursive: true });
    const timestamp = now().toISOString().replace(/[:.]/g, "-");
    const file = `app-${timestamp}-p${pid}.log`;
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

  /*
   * The active file is excluded and counted as one of maxFiles: it opens asynchronously, so it may
   * not be on disk yet, and it must never be pruned out from under the live stream. The directory
   * is shared with other processes, so a file over the cap is removed only when no live process
   * can still be writing it: this logger's own retired files, or files whose owner has exited and
   * that nothing has written to recently. Kept files still count against the cap.
   */
  function pruneOldLogs(activeFile: string): void {
    try {
      const files = readdirSync(dir)
        .map((name) => ({ name, match: LOG_FILE_RE.exec(name) }))
        .filter(({ name, match }) => name !== activeFile && match !== null)
        .map(({ name, match }) => ({
          path: join(dir, name),
          owner: match?.[1] !== undefined ? Number(match[1]) : undefined,
          mtimeMs: statSync(join(dir, name)).mtimeMs,
        }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      const wallClockMs = Date.now();
      for (const old of files.slice(Math.max(0, maxFiles - 1))) {
        const ours = old.owner === pid;
        const ownerLive = !ours && old.owner !== undefined && isProcessAlive(old.owner);
        const recentlyWritten = wallClockMs - old.mtimeMs < RECENT_WRITE_GRACE_MS;
        if (ours || (!ownerLive && !recentlyWritten)) unlinkSync(old.path);
      }
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
