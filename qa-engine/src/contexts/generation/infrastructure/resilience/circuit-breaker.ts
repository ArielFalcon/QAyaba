/* Circuit breaker state is keyed per agent role (the `agent`/descriptor.role identity every
   caller already threads through AgentDeps.open) so a run-away role (e.g. a stalled qa-reviewer)
   cannot trip the breaker for an unrelated, healthy role (e.g. qa-generator), and a success on one
   role can never reset another role's genuinely-accumulating failure streak.
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

export function checkCircuit(role: string): void {
  const s = circuits.get(role);
  if (!s || !s.open) return;
  const elapsed = Date.now() - s.lastFailure;
  if (elapsed < CIRCUIT_COOLDOWN_MS) {
    throw new Error(`OpenCode circuit breaker is OPEN (cooldown ${Math.round((CIRCUIT_COOLDOWN_MS - elapsed) / 1000)}s remaining)`);
  }
  s.open = false;
  s.failures = 0;
}

export function recordCircuitFailure(role: string): void {
  const s = stateFor(role);
  s.failures++;
  s.lastFailure = Date.now();
  if (s.failures >= CIRCUIT_THRESHOLD) {
    s.open = true;
    console.warn(`[qa] OpenCode circuit breaker OPENED for role "${role}" after ${s.failures} consecutive failures`);
  }
}

export function recordCircuitSuccess(role: string): void {
  const s = circuits.get(role);
  if (s && s.failures > 0) {
    s.failures = 0;
    s.open = false;
  }
}

/** Omit `role` to reset every role's state at once (e.g. a full shared-client teardown). */
export function resetCircuit(role?: string): void {
  if (role === undefined) {
    circuits.clear();
    return;
  }
  circuits.delete(role);
}
