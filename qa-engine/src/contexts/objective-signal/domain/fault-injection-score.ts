/* No side effects, no src/ import: this is the domain half of the e2e value oracle. See fault-injection-oracle.adapter.ts for the orchestration half (the browser re-run + JSON-corruption marker reads, which stay effectful and live in infrastructure/). A spec that STAYS GREEN under corrupted response data has a weak oracle (it would accept a backend regression). valueScore = the fraction of baseline-passing specs that NOTICED the corruption — the "response-oracle catch-rate". Signal-only: never gates publish by itself. */
import type { QaCase } from "@kernel/qa-case.ts";

export const FLOW_BREAK =
  /net::ERR|\bERR_[A-Z_]+|page\.goto|Target (?:closed|page, context or browser has been closed)|Execution context was destroyed|ECONNREFUSED/i;

export function isFlowBreak(c: QaCase): boolean {
  return FLOW_BREAK.test(`${c.detail ?? ""} ${c.reason ?? ""}`);
}

export function computeFaultInjectionScore(
  baselinePass: string[],
  corrupted: QaCase[],
): { valueScore: number | null; killed: number; total: number } {
  if (baselinePass.length === 0) return { valueScore: null, killed: 0, total: 0 };
  const byName = new Map(corrupted.map((c) => [c.name, c]));
  let killed = 0;
  for (const name of baselinePass) {
    const c = byName.get(name);
    if (!c) continue;
    if (c.status === "fail" || c.status === "flaky") {
      if (isFlowBreak(c)) continue;
      killed++;
    }
  }
  return { valueScore: killed / baselinePass.length, killed, total: baselinePass.length };
}
