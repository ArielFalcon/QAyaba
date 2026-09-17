
import type { RawOpencodeEvent } from "./activity-mapper.ts";

export type ReexploreKind = "navigate" | "snapshot" | "serena";

export interface ReexploreCounts {
  navigate: number;
  snapshot: number;
  serena: number;
  total: number;
}

const SERENA_RE =
  /(activate_project|find_referencing_symbols|find_symbol|get_symbols_overview|read_file|search_for_pattern|find_file|list_dir)/i;

export function reexploreToolKind(tool: string): ReexploreKind | null {
  if (/browser_navigate(?!_)/i.test(tool)) return "navigate";
  if (/browser_snapshot/i.test(tool)) return "snapshot";
  if (SERENA_RE.test(tool)) return "serena";
  return null;
}

interface PartLike {
  type?: string;
  tool?: string;
  state?: { status?: string };
}

export function reexploreKindFromEvent(event: RawOpencodeEvent): ReexploreKind | null {
  if (event.type !== "message.part.updated") return null;
  const part = event.properties?.part as PartLike | undefined;
  if (!part || part.type !== "tool" || !part.tool) return null;
  const status = part.state?.status;
  if (status !== "completed" && status !== "error") return null;
  return reexploreToolKind(part.tool);
}

export class ReexploreTracker {
  private counts = new Map<string, ReexploreCounts>();
  private seen = new Map<string, Set<string>>();

  record(sessionId: string, kind: ReexploreKind, callId?: string): void {
    if (callId) {
      const seenForSession = this.seen.get(sessionId) ?? new Set<string>();
      if (seenForSession.has(callId)) return;
      seenForSession.add(callId);
      this.seen.set(sessionId, seenForSession);
    }
    const c = this.counts.get(sessionId) ?? { navigate: 0, snapshot: 0, serena: 0, total: 0 };
    c[kind] += 1;
    c.total += 1;
    this.counts.set(sessionId, c);
  }

  snapshot(sessionId: string): ReexploreCounts {
    const c = this.counts.get(sessionId);
    return c ? { ...c } : { navigate: 0, snapshot: 0, serena: 0, total: 0 };
  }

  clear(sessionId: string): void {
    this.counts.delete(sessionId);
    this.seen.delete(sessionId);
  }
}

export const reexploreTracker = new ReexploreTracker();
