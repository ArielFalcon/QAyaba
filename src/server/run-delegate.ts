/*
 * Delegate a manual run to the running orchestrator instead of a second in-process queue.
 * Keeps the one-run-at-a-time-against-DEV invariant: the server owns the only queue.
 */

import type { RunMode, TestTarget } from "../types";

export interface DelegateRunInput {
  app: string;
  sha: string;
  target: TestTarget;
  mode: RunMode;
  guidance?: string;
}

export interface DelegateRunDeps {
  fetch: typeof fetch;
  baseUrl: string;
  token?: string;
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
  onUpdate?: (rec: { status: string; step?: string }) => void;
}

export interface DelegateRunResult {
  id: string;
  status: string;
  verdict: string | null;
  passed: number;
  failed: number;
  note?: string;
  timedOut: boolean;
}

export async function delegateRun(input: DelegateRunInput, deps: DelegateRunDeps): Promise<DelegateRunResult> {
  const pollMs = deps.pollMs ?? 1500;
  const timeoutMs = deps.timeoutMs ?? 30 * 60_000;
  const now = deps.now ?? Date.now;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (deps.token) headers.Authorization = `Bearer ${deps.token}`;

  const createRes = await deps.fetch(`${deps.baseUrl}/api/v1/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      app: input.app,
      sha: input.sha,
      target: input.target,
      mode: input.mode,
      ...(input.guidance ? { guidance: input.guidance } : {}),
    }),
  });
  const createBody = (await createRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!createRes.ok) {
    const msg = typeof createBody.error === "string" ? createBody.error : `HTTP ${createRes.status}`;
    throw new Error(`the service rejected the run: ${msg}`);
  }
  const id = typeof createBody.id === "string" ? createBody.id : "";
  if (!id) throw new Error("the service accepted the run but returned no run id");

  const start = now();
  let last: DelegateRunResult = { id, status: "enqueued", verdict: null, passed: 0, failed: 0, timedOut: false };
  for (;;) {
    /* Transient network errors must not abort the wait — the run keeps running server-side. */
    let res: Response;
    try {
      res = await deps.fetch(`${deps.baseUrl}/api/v1/runs/${encodeURIComponent(id)}`, { headers });
    } catch {
      deps.onUpdate?.({ status: "reconnecting" });
      if (now() - start > timeoutMs) return { ...last, timedOut: true };
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error("the service rejected the token (401/403) — set QA_API_TOKEN or config/.api_token");
    }
    if (res.ok) {
      const rec = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (rec) {
        last = {
          id,
          status: typeof rec.status === "string" ? rec.status : "running",
          verdict: typeof rec.verdict === "string" ? rec.verdict : null,
          passed: typeof rec.passed === "number" ? rec.passed : 0,
          failed: typeof rec.failed === "number" ? rec.failed : 0,
          note: typeof rec.note === "string" ? rec.note : undefined,
          timedOut: false,
        };
        deps.onUpdate?.({ status: last.status, step: typeof rec.step === "string" ? rec.step : undefined });
        if (last.status === "done") return last;
      }
    }
    if (now() - start > timeoutMs) return { ...last, timedOut: true };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
