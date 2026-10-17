/* The process-wide telemetry handle, built once at start by src/index.ts and src/cli.ts (the composition roots). The engine factory takes `processTelemetry().telemetry` as a dep; nothing else reads the environment for telemetry. */

import { createTelemetry, type TelemetryHandle } from "./bootstrap";

/* Bounds the final flush and stop of the exporters on exit. */
export const TELEMETRY_SHUTDOWN_TIMEOUT_MS = 5000;

let handle: TelemetryHandle | undefined;

export function processTelemetry(env: Record<string, string | undefined> = process.env): TelemetryHandle {
  handle ??= createTelemetry({ env, registerGlobal: true });
  return handle;
}

export function resetProcessTelemetryForTests(): void {
  handle = undefined;
}
