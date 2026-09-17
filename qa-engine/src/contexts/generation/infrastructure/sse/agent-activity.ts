/* `ActivityKind` is declared locally below (mirrors src/types.ts's own 5-value union) — qa-engine never imports src/. Authoritative event shapes (from @opencode-ai/sdk types): message.part.updated → { part: Part, delta? } sessionID lives in part.sessionID part.type "tool" → { tool, state:{ status, input, title } } (write/edit/bash/…) part.type "patch" → { files: string[] } part.type "file" → { filename } part.type text/reasoning/step → PROSE → dropped (this was the broken `"file": "s`) todo.updated → { sessionID, todos: Todo[] } (each: content, status, priority, id) command.executed → { sessionID, name, arguments } file.edited → { file } (no sessionID — cannot be run-scoped) session.error → { sessionID?, error } The router demuxes by sessionID → runId and stays ADVISORY-ONLY. Raw model prose is never surfaced — only clean structured fields (the file written, the command run, the todo the agent is on). */

/** Mirrors src/types.ts's own ActivityKind exactly — declared locally (qa-engine never imports src/). */
export type ActivityKind = "file" | "command" | "todo" | "phase" | "error";

export interface RoutedActivity {
  runId: string;
  kind: ActivityKind;
  text: string;
  status?: "pending" | "in_progress" | "completed";
}

export interface RawEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export type DropReason = "no-session" | "unknown-session" | "unknown-kind";

export interface RouteResult {
  activities: RoutedActivity[];
  dropped?: DropReason;
}

const FILE_TOOLS = /^(write|edit|multiedit|create|apply_patch|patch)$/i;
const SHELL_TOOLS = /^(bash|shell|run)$/i;

function basename(path: string): string {
  return String(path).split(/[\\/]/).pop() || String(path);
}

function cap(s: string): string {
  return s.length > 500 ? s.slice(0, 500) : s;
}

function normalizeStatus(raw: unknown): RoutedActivity["status"] {
  const s = String(raw ?? "").toLowerCase();
  if (s === "completed" || s === "done" || s === "complete") return "completed";
  if (s === "in_progress" || s === "in-progress" || s === "active" || s === "running") return "in_progress";
  return "pending";
}

interface PartLike {
  type?: string;
  sessionID?: string;
  tool?: string;
  filename?: string;
  files?: unknown;
  state?: { status?: string; input?: Record<string, unknown>; title?: string };
}

function fromPart(runId: string, part: PartLike | undefined): RoutedActivity[] {
  if (!part || typeof part !== "object") return [];

  if (part.type === "tool") {
    const tool = String(part.tool ?? "");
    const state = part.state ?? {};
    if (state.status !== "completed") return [];
    const input = (state.input ?? {}) as Record<string, unknown>;
    if (FILE_TOOLS.test(tool)) {
      const f = input.filePath ?? input.path ?? input.file ?? input.filename;
      if (f) return [{ runId, kind: "file", text: basename(String(f)) }];
    }
    if (SHELL_TOOLS.test(tool)) {
      const cmd = input.command ?? input.cmd ?? input.script;
      if (cmd) return [{ runId, kind: "command", text: cap(String(cmd).trim()) }];
    }
    return [];
  }

  if (part.type === "patch" && Array.isArray(part.files)) {
    return (part.files as unknown[])
      .filter((f): f is string => typeof f === "string" && f.length > 0)
      .map((f) => ({ runId, kind: "file" as const, text: basename(f) }));
  }

  if (part.type === "file" && part.filename) {
    return [{ runId, kind: "file", text: basename(String(part.filename)) }];
  }

  return [];
}

export function routeEvent(event: RawEvent, sessions: ReadonlyMap<string, string>): RouteResult {
  const p = event.properties ?? {};
  const part = p.part as PartLike | undefined;
  const sessionID = (p.sessionID as string | undefined) ?? part?.sessionID;
  if (!sessionID) return { activities: [], dropped: "no-session" };
  const runId = sessions.get(sessionID);
  if (!runId) return { activities: [], dropped: "unknown-session" };

  switch (event.type) {
    case "message.part.updated":
      return { activities: fromPart(runId, part) };

    case "todo.updated": {
      const todos = Array.isArray(p.todos) ? (p.todos as Array<{ content?: string; status?: string }>) : [];
      const activities = todos
        .filter((t) => (t.content ?? "").trim())
        .map((t) => ({ runId, kind: "todo" as const, text: cap(t.content!.trim()), status: normalizeStatus(t.status) }));
      return { activities };
    }

    case "command.executed": {
      const cmd = [p.name, p.arguments].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
      return { activities: cmd ? [{ runId, kind: "command", text: cap(cmd) }] : [] };
    }

    case "file.edited":
      return { activities: p.file ? [{ runId, kind: "file", text: basename(String(p.file)) }] : [] };

    case "session.error":
      return { activities: [{ runId, kind: "error", text: cap(`error: ${String(p.error ?? "unknown")}`) }] };

    default:
      return { activities: [], dropped: "unknown-kind" };
  }
}

export class ActivityRouter {
  private readonly sessions = new Map<string, string>();
  private readonly context = new Map<string, SessionContext>();
  private readonly workers = new Map<string, string>();
  readonly drops: Record<DropReason, number> = { "no-session": 0, "unknown-session": 0, "unknown-kind": 0 };

  register(sessionId: string, runId: string, workerId?: string): void {
    this.sessions.set(sessionId, runId);
    this.context.set(sessionId, { lastFile: undefined, lastTodo: undefined, fileCount: 0, emitted: new Set() });
    if (workerId) this.workers.set(sessionId, workerId);
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.context.delete(sessionId);
    this.workers.delete(sessionId);
  }

  sessionMap(): ReadonlyMap<string, string> {
    return this.sessions;
  }

  workerMap(): ReadonlyMap<string, string> {
    return this.workers;
  }

  route(event: RawEvent): RoutedActivity[] {
    const r = routeEvent(event, this.sessions);
    if (r.dropped) this.drops[r.dropped]++;
    if (r.activities.length === 0) return [];

    const sid = [...this.sessions.entries()].find(([, rid]) => rid === r.activities[0]!.runId)?.[0];
    const ctx = sid ? this.context.get(sid) : undefined;

    const out: RoutedActivity[] = [];
    for (const a of r.activities) {
      const key = `${a.kind}:${a.text}:${a.status ?? ""}`;
      if (ctx) {
        if (ctx.emitted.has(key)) continue;
        ctx.emitted.add(key);
        if (a.kind === "file") { ctx.lastFile = a.text; ctx.fileCount++; }
        else if (a.kind === "todo") ctx.lastTodo = a.text;
      }
      out.push(a);
    }
    return out;
  }

  getContext(sessionId: string): string {
    const ctx = this.context.get(sessionId);
    if (!ctx) return "";
    const parts: string[] = [];
    if (ctx.lastTodo) parts.push(ctx.lastTodo);
    if (ctx.fileCount > 0) parts.push(`files edited: ${ctx.fileCount}`);
    if (ctx.lastFile) parts.push(ctx.lastFile);
    return parts.join(" — ");
  }

  contextForRun(runId: string): string {
    for (const [sid, rid] of this.sessions) {
      if (rid === runId) return this.getContext(sid);
    }
    return "";
  }
}

interface SessionContext {
  lastFile?: string;
  lastTodo?: string;
  fileCount: number;
  emitted: Set<string>;
}
