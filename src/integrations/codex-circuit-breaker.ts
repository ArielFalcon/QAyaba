/*
 * Codex transport circuit breaker — separate process-global state from OpenCode so one
 * provider's outage never gates the other. Open after consecutive failures; cooldown then retry.
 */

let circuitFailures = 0;
let circuitOpen = false;
let circuitLastFailure = 0;
const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000;

export function checkCodexCircuit(): void {
  if (circuitOpen) {
    const elapsed = Date.now() - circuitLastFailure;
    if (elapsed < CIRCUIT_COOLDOWN_MS) {
      throw new Error(`Codex circuit breaker is OPEN (cooldown ${Math.round((CIRCUIT_COOLDOWN_MS - elapsed) / 1000)}s remaining)`);
    }
    circuitOpen = false;
    circuitFailures = 0;
  }
}

export function recordCodexCircuitFailure(): void {
  circuitFailures++;
  circuitLastFailure = Date.now();
  if (circuitFailures >= CIRCUIT_THRESHOLD) {
    circuitOpen = true;
    console.warn(`[qa] Codex circuit breaker OPENED after ${circuitFailures} consecutive failures`);
  }
}

export function recordCodexCircuitSuccess(): void {
  if (circuitFailures > 0) {
    circuitFailures = 0;
    circuitOpen = false;
  }
}

/* Clear on dispose/restart so rotating the API key is not blocked by a stale OPEN circuit. */
export function resetCodexCircuit(): void {
  circuitFailures = 0;
  circuitOpen = false;
  circuitLastFailure = 0;
}
