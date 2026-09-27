import { join } from "node:path";

/* The orchestrator's root (config/, data/, .env): QAYABA_ROOT, else the working directory. */
export function qayabaRoot(): string {
  return process.env.QAYABA_ROOT ?? process.cwd();
}

/*
 * The data directory under the root (the qa-data volume): run history, logs, auth material and
 * telemetry. The agents container never mounts it.
 */
export function qayabaDataDir(): string {
  return join(qayabaRoot(), "data");
}
