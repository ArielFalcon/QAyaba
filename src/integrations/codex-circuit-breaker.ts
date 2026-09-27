/*
 * Codex transport circuit breaker — separate process-global state from OpenCode so one
 * provider's outage never gates the other. Open after consecutive failures; cooldown then retry.
 *
 * State is keyed per agent role (mirrors qa-engine/src/contexts/generation/infrastructure/
 * resilience/circuit-breaker.ts), so a run-away role (e.g. a stalled reviewer) cannot trip the
 * breaker for an unrelated, healthy role (e.g. the primary generator), and a success on one role
 * can never reset another role's genuinely-accumulating failure streak.
 */

interface CircuitState {
  failures: number;
  open: boolean;
  lastFailure: number;
}

const circuits = new Map<string, CircuitState>();
const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000;

function stateFor(role: string): CircuitState {
  let s = circuits.get(role);
  if (!s) {
    s = { failures: 0, open: false, lastFailure: 0 };
    circuits.set(role, s);
  }
  return s;
}

export function checkCodexCircuit(role: string): void {
  const s = circuits.get(role);
  if (!s || !s.open) return;
  const elapsed = Date.now() - s.lastFailure;
  if (elapsed < CIRCUIT_COOLDOWN_MS) {
    throw new Error(`Codex circuit breaker is OPEN (cooldown ${Math.round((CIRCUIT_COOLDOWN_MS - elapsed) / 1000)}s remaining)`);
  }
  s.open = false;
  s.failures = 0;
}

export function recordCodexCircuitFailure(role: string): void {
  const s = stateFor(role);
  s.failures++;
  s.lastFailure = Date.now();
  if (s.failures >= CIRCUIT_THRESHOLD) {
    s.open = true;
    console.warn(`[qa] Codex circuit breaker OPENED for role "${role}" after ${s.failures} consecutive failures`);
  }
}

export function recordCodexCircuitSuccess(role: string): void {
  const s = circuits.get(role);
  if (s && s.failures > 0) {
    s.failures = 0;
    s.open = false;
  }
}

/** Omit `role` to reset every role's state at once (e.g. dispose/restart, rotating the API key). */
export function resetCodexCircuit(role?: string): void {
  if (role === undefined) {
    circuits.clear();
    return;
  }
  circuits.delete(role);
}
