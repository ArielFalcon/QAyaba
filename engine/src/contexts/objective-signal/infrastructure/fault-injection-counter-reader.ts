/* A mutation re-run leaves one counter file per worker under `.qa/fault-injection/<namespace>`, `{ "corrupted": n }`: how many script responses that worker mutated. The orchestrator adds them up to tell "the mutant never reached a page" (zero: it is not judged) from "a test noticed it or none did". The counters are written by a run of the tests, which executes code the agent wrote, so they are read like everything else it leaves: through run-output-reader, strictly and under a cap. The counters are used whole or not at all: when one cannot be used (a pipe, a link, one over its cap, one that is not JSON, a directory that cannot be used) the count is unknown, said aloud, since the counters that could be read are a part of the whole and a part of a count is no count. A mutant whose count is unknown is not judged. Signal-only: it never gates publish. */
import { MAX_FAULT_INJECTION_COUNTER_BYTES, MAX_FAULT_INJECTION_COUNTER_FILES } from "../domain/dump-sanitizers.ts";
import { readRunOutputDir, type RunOutputLimits } from "../../../shared-infrastructure/run-output-reader.ts";

export const FAULT_INJECTION_COUNTER_LIMITS: RunOutputLimits = {
  maxFileBytes: MAX_FAULT_INJECTION_COUNTER_BYTES,
  maxTotalBytes: MAX_FAULT_INJECTION_COUNTER_BYTES * 256,
  maxFiles: MAX_FAULT_INJECTION_COUNTER_FILES,
};

/* How many responses the re-run of `namespace` says it mutated, below the project directory `e2eDir`: zero when it left no counter, and undefined when the count cannot be told because a counter could not be used. A counter that holds no number counts for nothing; keys other than the count are not read. */
export function countInjectedResponses(e2eDir: string, namespace: string, limits: RunOutputLimits = FAULT_INJECTION_COUNTER_LIMITS): number | undefined {
  const counts = readRunOutputDir(
    { mirrorDir: e2eDir, specDir: e2eDir },
    `.qa/fault-injection/${namespace}`,
    () => true,
    (_name, bytes): number => {
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      return Number((parsed as { corrupted?: unknown }).corrupted) || 0;
    },
    limits,
  );
  return counts?.reduce((sum, count) => sum + count, 0);
}
