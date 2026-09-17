
import type { RunEventBody } from "@kernel/contract/events.ts";
import { ActivityRouter, type ActivityKind } from "./agent-activity.ts";
import { mapOpencodeEvent, eventRunId } from "./activity-mapper.ts";
import { reexploreKindFromEvent, reexploreTracker } from "./reexplore.ts";
import { notifySessionActivity } from "../agent-transport-policy.ts";

export interface LiveActivity {
  runId: string;
  kind: ActivityKind;
  text: string;
  status?: "pending" | "in_progress" | "completed";
  display: string;
}

export interface RawEventStreamOpener {
  open(directory: string): Promise<AsyncIterable<{ type?: string; properties?: Record<string, unknown> }> | undefined>;
}

let rawOpener: RawEventStreamOpener | undefined;

/** Called once by the composition root before any run attaches a session. A stream attempted before this is wired throws — never a silent no-op. */
export function setRawEventStreamOpener(opener: RawEventStreamOpener): void {
  rawOpener = opener;
}

export const activityRouter = new ActivityRouter();

async function startScopedEventStream(
  directory: string,
  onActivity: (a: LiveActivity) => void,
  signal?: AbortSignal,
  onRunEvent?: (runId: string, body: RunEventBody) => void,
): Promise<void> {
  if (!rawOpener) {
    throw new Error(
      "EventStreamManager: no RawEventStreamOpener wired — the composition root must call setRawEventStreamOpener before opening any stream",
    );
  }
  const stream = await rawOpener.open(directory);
  if (!stream) {
    console.warn(`[qa] SSE event stream returned no stream (${directory})`);
    return;
  }

  try {
    for await (const event of stream) {
      if (signal?.aborted) break;

      const evt = event as { type?: string; properties?: Record<string, unknown> };
      if (!evt.type) continue;

      const raw = { type: evt.type, properties: evt.properties };

      const reexKind = reexploreKindFromEvent(raw);
      const rawPart = raw.properties?.part as { sessionID?: string; callID?: string } | undefined;
      if (reexKind && rawPart?.sessionID) {
        reexploreTracker.record(rawPart.sessionID, reexKind, rawPart.callID);
      }
      /* Notify the liveness watchdog for this session: any event proves the agent is alive. Advisory-only: if the sessionID is not in the registry (no watchdog) this is a no-op. */
      if (rawPart?.sessionID) notifySessionActivity(rawPart.sessionID);

      if (onRunEvent) {
        const rid = eventRunId(raw, activityRouter.sessionMap());
        if (rid) {
          for (const body of mapOpencodeEvent(raw, activityRouter.sessionMap(), activityRouter.workerMap())) {
            try { onRunEvent(rid, body); } catch { /* advisory */ }
          }
        }
      }

      const activities = activityRouter.route(raw);

      for (const activity of activities) {
        let shown = activity.text;
        if (activity.kind === "command") {
          const parts = shown.split(/\s+/);
          if (parts.length > 4) shown = parts.slice(0, 4).join(" ") + " …";
        }
        const icon = activity.kind === "file" ? "✎" : activity.kind === "command" ? "⚙" : activity.kind === "error" ? "⚠" : "▸";
        const label = activity.kind === "file" ? `wrote ${shown}` : shown;
        onActivity({
          runId: activity.runId,
          kind: activity.kind,
          text: activity.text,
          ...(activity.status ? { status: activity.status } : {}),
          display: `[qa] ${icon} ${label}`,
        });
      }
    }
  } catch (err) {
    if (!signal?.aborted) {
      console.warn(`[qa] SSE event stream error (${directory}): ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    console.log(`[qa] SSE event stream closed (${directory})`);
  }
}

export interface EventStreamReconnectOptions {
  start: (onActivity: (a: LiveActivity) => void, signal?: AbortSignal, onRunEvent?: (runId: string, body: RunEventBody) => void) => Promise<void>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  initialDelayMs?: number;
  maxDelayMs?: number;
  log?: (msg: string) => void;
  onRunEvent?: (runId: string, body: RunEventBody) => void;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function startEventStreamWithReconnect(
  onActivity: (a: LiveActivity) => void,
  signal?: AbortSignal,
  opts: EventStreamReconnectOptions = { start: () => { throw new Error("startEventStreamWithReconnect requires a scoped `start`"); } },
): Promise<void> {
  const start = opts.start;
  const sleep = opts.sleep ?? sleepWithAbort;
  const initialDelayMs = opts.initialDelayMs ?? 1_000;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  let delayMs = initialDelayMs;

  while (!signal?.aborted) {
    try {
      await start(onActivity, signal, opts.onRunEvent);
      delayMs = initialDelayMs;
      if (!signal?.aborted) opts.log?.(`[qa] OpenCode event stream closed; reconnecting in ${delayMs}ms`);
    } catch (err) {
      if (signal?.aborted) break;
      opts.log?.(`[qa] OpenCode event stream failed: ${err instanceof Error ? err.message : String(err)}; reconnecting in ${delayMs}ms`);
    }
    if (signal?.aborted) break;
    await sleep(delayMs, signal);
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }
}

export type OpenStreamFn = (
  directory: string,
  onActivity: (a: LiveActivity) => void,
  signal: AbortSignal,
  onRunEvent?: (runId: string, body: RunEventBody) => void,
) => void;

const defaultOpenStream: OpenStreamFn = (directory, onActivity, signal, onRunEvent) => {
  void startEventStreamWithReconnect(onActivity, signal, {
    onRunEvent,
    start: (oa, sig, ore) => startScopedEventStream(directory, oa, sig, ore),
    log: (m) => console.log(m),
  });
};

export class EventStreamManager {
  private onActivity?: (a: LiveActivity) => void;
  private onRunEvent?: (runId: string, body: RunEventBody) => void;
  private shutdown?: AbortSignal;
  private readonly dirs = new Map<string, { refs: number; abort: AbortController; started: boolean }>();
  private readonly sessionDir = new Map<string, string>();

  constructor(private readonly openStream: OpenStreamFn = defaultOpenStream) {}

  setSink(onActivity: (a: LiveActivity) => void, shutdown?: AbortSignal, onRunEvent?: (runId: string, body: RunEventBody) => void): void {
    this.onActivity = onActivity;
    this.onRunEvent = onRunEvent;
    this.shutdown = shutdown;
    shutdown?.addEventListener("abort", () => this.closeAll(), { once: true });
    for (const dir of this.dirs.keys()) this.ensureStream(dir);
  }

  attach(sessionId: string, directory: string): void {
    if (this.shutdown?.aborted) return;
    this.sessionDir.set(sessionId, directory);
    const existing = this.dirs.get(directory);
    if (existing) { existing.refs++; return; }
    this.dirs.set(directory, { refs: 1, abort: new AbortController(), started: false });
    this.ensureStream(directory);
  }

  detach(sessionId: string): void {
    const directory = this.sessionDir.get(sessionId);
    if (!directory) return;
    this.sessionDir.delete(sessionId);
    const entry = this.dirs.get(directory);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) {
      entry.abort.abort();
      this.dirs.delete(directory);
    }
  }

  private ensureStream(directory: string): void {
    if (!this.onActivity) return;
    const entry = this.dirs.get(directory);
    if (!entry || entry.started) return;
    entry.started = true;
    this.openStream(directory, this.onActivity, entry.abort.signal, this.onRunEvent);
  }

  private closeAll(): void {
    for (const entry of this.dirs.values()) entry.abort.abort();
    this.dirs.clear();
    this.sessionDir.clear();
  }
}

const eventStreams = new EventStreamManager();

export function startActivitySink(
  onActivity: (a: LiveActivity) => void,
  signal?: AbortSignal,
  opts: { onRunEvent?: (runId: string, body: RunEventBody) => void } = {},
): Promise<void> {
  eventStreams.setSink(onActivity, signal, opts.onRunEvent);
  return new Promise<void>((resolve) => {
    if (!signal) return;
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function registerRunSession(sessionId: string, runId: string, directory: string, workerId?: string): void {
  activityRouter.register(sessionId, runId, workerId);
  eventStreams.attach(sessionId, directory);
}

export function unregisterRunSession(sessionId: string): void {
  activityRouter.unregister(sessionId);
  eventStreams.detach(sessionId);
  reexploreTracker.clear(sessionId);
}
