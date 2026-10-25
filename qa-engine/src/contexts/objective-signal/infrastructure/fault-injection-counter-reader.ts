/* The corrupted re-run of the response oracle leaves one counter file per worker under `.qa/fault-injection/<namespace>`, `{ "corrupted": n }`: how many JSON responses that worker corrupted; a mutation re-run leaves the same counter, under its own namespace, for the script responses it mutated. The orchestrator adds them up to tell "no JSON response was there to corrupt" (zero: the oracle does not apply, no score) from "the suite stayed green under corrupted data". The counters are written by a run of the tests, which executes code the agent wrote, so they are read like everything else it leaves: through run-output-reader, strictly and under a cap. The counters are used whole or not at all: when one cannot be used (a pipe, a link, one over its cap, one that is not JSON, a directory that cannot be used) the count is unknown, said aloud, since the counters that could be read are a part of the whole and a part of a count is no count. The oracle gives no score for an unknown count. Signal-only: a null score never gates publish. */
import { readRunOutputDir, type RunOutputLimits } from "../../../shared-infrastructure/run-output-reader.ts";

/* A counter is a few bytes; one worker is one file, and a worker is started again after a failure, so a long suite leaves many. */
export const MAX_FAULT_INJECTION_COUNTER_BYTES = 64 * 1024;
export const MAX_FAULT_INJECTION_COUNTER_FILES = 2_048;
export const FAULT_INJECTION_COUNTER_LIMITS: RunOutputLimits = {
  maxFileBytes: MAX_FAULT_INJECTION_COUNTER_BYTES,
  maxTotalBytes: MAX_FAULT_INJECTION_COUNTER_BYTES * 256,
  maxFiles: MAX_FAULT_INJECTION_COUNTER_FILES,
};

/* How many responses the corrupted re-run of `namespace` says it corrupted, below the project directory `e2eDir`: zero when it left no counter, and undefined when the count cannot be told because a counter could not be used. */
export function countInjectedResponses(e2eDir: string, namespace: string, limits: RunOutputLimits = FAULT_INJECTION_COUNTER_LIMITS): number | undefined {
  const counts = readRunOutputDir(
    { mirrorDir: e2eDir, specDir: e2eDir },
    `.qa/fault-injection/${namespace}`,
    () => true,
    (_name, bytes) => Number((JSON.parse(bytes.toString("utf8")) as { corrupted?: unknown }).corrupted) || 0,
    limits,
  );
  return counts?.reduce((sum, count) => sum + count, 0);
}

/* The largest count a counter may hold: far beyond any suite's responses, and a bound on what the field can carry. */
export const MAX_FAULT_INJECTION_COUNT = 1_000_000_000;

/* A counter as the orchestrator keeps it for the reader: `{ "corrupted": n }` with nothing else, rebuilt from the count. The counter is written by the suite's fixtures (agent-editable code) and reaches a folder the agent reads, so no other key survives. Throws RangeError on anything that is not a non-negative integer count. */
export function sanitizeFaultCounter(bytes: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new RangeError("not JSON");
  }
  const corrupted = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as { corrupted?: unknown }).corrupted : undefined;
  if (typeof corrupted !== "number" || !Number.isInteger(corrupted) || corrupted < 0 || corrupted > MAX_FAULT_INJECTION_COUNT) throw new RangeError("not a count");
  return Buffer.from(JSON.stringify({ corrupted }));
}
