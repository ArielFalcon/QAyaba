/*
 * File-backed CoordinationTelemetryPort adapter. Wraps the pure CoordinationTelemetryRecorder with
 * a durable JSONL sink: events are sanitized then appended live, and reloaded at construction so
 * adaptive-routing thresholds and the audit ledger survive process restarts. Kept out of
 * application/ (fs I/O is an infrastructure concern) — this is the ONLY place coordination
 * telemetry touches the filesystem.
 *
 * Bounded growth (O6): once the in-memory event count exceeds MAX_LEDGER_EVENTS, the sink is
 * rotated — rewritten to hold only the most recent ROTATE_TO_EVENTS entries (a lower watermark,
 * not the cap itself). Trimming to a watermark WITH SLACK below the cap (J2) means rotation's
 * synchronous full-ledger rewrite (writeFileSync + renameSync) fires only once per
 * (MAX_LEDGER_EVENTS - ROTATE_TO_EVENTS) records, instead of on every single record() once the
 * cap is crossed — a long-lived process's ledger file (and therefore the cost of reloading it on
 * the NEXT boot) never grows unbounded, without paying a full rewrite on every record.
 */
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { sanitizeText } from "@contexts/generation/infrastructure/sanitize-text.ts";
import {
  CoordinationTelemetryRecorder,
  type CoordinationTelemetryEvent,
  type CoordinationTelemetryPort,
} from "../../application/coordination/coordination-telemetry.ts";

/** Retention cap: max events kept in memory AND on disk. See this file's header. */
export const MAX_LEDGER_EVENTS = 5000;

/** Rotation watermark (J2): once MAX_LEDGER_EVENTS is crossed, trim down to this lower target
 * (80% of the cap) instead of back to the cap itself, so the next (MAX_LEDGER_EVENTS -
 * ROTATE_TO_EVENTS) records grow the ledger via plain appends before another full rewrite is
 * needed. See this file's header. */
export const ROTATE_TO_EVENTS = Math.floor(MAX_LEDGER_EVENTS * 0.8);

export interface CoordinationTelemetryFsDeps {
  readonly appendFileSync: typeof appendFileSync;
  readonly readFileSync: typeof readFileSync;
  readonly writeFileSync: typeof writeFileSync;
  readonly renameSync: typeof renameSync;
}

export const defaultCoordinationTelemetryFsDeps: CoordinationTelemetryFsDeps = {
  appendFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
};

export class FileCoordinationTelemetryAdapter implements CoordinationTelemetryPort {
  private readonly recorder = new CoordinationTelemetryRecorder();
  private readonly persistPath: string | undefined;
  private readonly fs: CoordinationTelemetryFsDeps;
  private warnedPersistFailure = false;

  /*
   * persistPath: optional durable sink (JSONL, one event per line). Without it the store is
   * process-lifetime only (same contract InMemoryCoordinationTelemetry used to have). When present,
   * events are appended live and reloaded at construction so adaptive thresholds survive restarts.
   */
  constructor(persistPath?: string, fsDeps: CoordinationTelemetryFsDeps = defaultCoordinationTelemetryFsDeps) {
    this.fs = fsDeps;
    this.persistPath = persistPath ? this.normalize(persistPath) : undefined;
    if (this.persistPath) this.rehydrate();
  }

  get events(): readonly CoordinationTelemetryEvent[] {
    return this.recorder.events;
  }

  record(event: CoordinationTelemetryEvent): void {
    const safe = { ...event, reason: sanitizeText(event.reason).text };
    this.recorder.record(safe);
    if (this.persistPath) this.persist(safe);
  }

  private normalize(path: string): string {
    return path.replace(/\\/g, "/");
  }

  private rehydrate(): void {
    try {
      const raw = this.fs.readFileSync(this.persistPath!, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          this.recorder.record(JSON.parse(trimmed) as CoordinationTelemetryEvent);
        } catch {
          /* Corrupt/partial tail line: skip it, never fail startup or previous runs' data. */
        }
      }
    } catch {
      /* Absent file on first boot is the normal cold-start case — not an error. */
    }
  }

  private persist(event: CoordinationTelemetryEvent): void {
    try {
      this.fs.appendFileSync(this.persistPath!, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
      this.warnedPersistFailure = false;
      this.rotateIfOverCap();
    } catch (err) {
      /* Telemetry is observational: a sink failure must never break the QA run, but it must not stay silent (surface integration errors loudly). Warn once per burst, reset on the next success. */
      if (!this.warnedPersistFailure) {
        this.warnedPersistFailure = true;
        console.error(
          `[qa] coordination telemetry persist failed (events kept in memory only): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /* Retention cap: once the in-memory count (which mirrors what has been appended) exceeds the
     cap, rewrite the file down to only the most recent ROTATE_TO_EVENTS entries — a lower
     watermark WITH SLACK below MAX_LEDGER_EVENTS (J2), so this full rewrite fires only once per
     slack window instead of on every record() past the cap. Written to a temp file and renamed
     into place so a crash mid-write never leaves a truncated ledger. A rotation failure is logged
     (never silent) but never breaks the run — telemetry stays observational. */
  private rotateIfOverCap(): void {
    if (this.recorder.events.length <= MAX_LEDGER_EVENTS) return;
    const kept = this.recorder.events.slice(this.recorder.events.length - ROTATE_TO_EVENTS);
    this.recorder.events.splice(0, this.recorder.events.length - ROTATE_TO_EVENTS);
    try {
      const tmpPath = `${this.persistPath!}.tmp`;
      this.fs.writeFileSync(tmpPath, `${kept.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
      this.fs.renameSync(tmpPath, this.persistPath!);
    } catch (err) {
      if (!this.warnedPersistFailure) {
        this.warnedPersistFailure = true;
        console.error(
          `[qa] coordination telemetry rotation failed (ledger keeps growing on disk): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

let shared: FileCoordinationTelemetryAdapter | undefined;

/* Process-lifetime singleton so adaptive thresholds see prior runs (not a fresh empty bag per composition). */
export function getSharedCoordinationTelemetry(persistPath?: string): FileCoordinationTelemetryAdapter {
  if (!shared) shared = new FileCoordinationTelemetryAdapter(persistPath);
  return shared;
}

/** Test-only: reset shared store between suites. */
export function resetSharedCoordinationTelemetryForTests(): void {
  shared = undefined;
}
