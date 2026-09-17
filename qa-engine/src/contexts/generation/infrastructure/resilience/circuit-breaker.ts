
let circuitFailures = 0;
let circuitOpen = false;
let circuitLastFailure = 0;
const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000;

export function checkCircuit(): void {
  if (circuitOpen) {
    const elapsed = Date.now() - circuitLastFailure;
    if (elapsed < CIRCUIT_COOLDOWN_MS) {
      throw new Error(`OpenCode circuit breaker is OPEN (cooldown ${Math.round((CIRCUIT_COOLDOWN_MS - elapsed) / 1000)}s remaining)`);
    }
    circuitOpen = false;
    circuitFailures = 0;
  }
}

export function recordCircuitFailure(): void {
  circuitFailures++;
  circuitLastFailure = Date.now();
  if (circuitFailures >= CIRCUIT_THRESHOLD) {
    circuitOpen = true;
    console.warn(`[qa] OpenCode circuit breaker OPENED after ${circuitFailures} consecutive failures`);
  }
}

export function recordCircuitSuccess(): void {
  if (circuitFailures > 0) {
    circuitFailures = 0;
    circuitOpen = false;
  }
}

export function resetCircuit(): void {
  circuitFailures = 0;
  circuitOpen = false;
  circuitLastFailure = 0;
}
