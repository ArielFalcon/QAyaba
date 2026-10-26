/* The corrupted re-run of the response oracle leaves one counter file per worker under `.qa/fault-injection/<namespace>`, `{ "corrupted": n }`: how many JSON responses that worker corrupted; a mutation re-run leaves the same counter, under its own namespace, for the script responses it mutated. The orchestrator adds them up to tell "no JSON response was there to corrupt" (zero: the oracle does not apply, no score) from "the suite stayed green under corrupted data". The counters are written by a run of the tests, which executes code the agent wrote, so they are read like everything else it leaves: through run-output-reader, strictly and under a cap. The counters are used whole or not at all: when one cannot be used (a pipe, a link, one over its cap, one that is not JSON, a directory that cannot be used) the count is unknown, said aloud, since the counters that could be read are a part of the whole and a part of a count is no count. The oracle gives no score for an unknown count. Signal-only: a null score never gates publish. */
import { MAX_FAULT_INJECTION_COUNTER_BYTES, MAX_FAULT_INJECTION_COUNTER_FILES, parseFaultCounterFields, type FaultCounterRecord } from "../domain/dump-sanitizers.ts";
import { readRunOutputDir, type RunOutputLimits } from "../../../shared-infrastructure/run-output-reader.ts";

export const FAULT_INJECTION_COUNTER_LIMITS: RunOutputLimits = {
  maxFileBytes: MAX_FAULT_INJECTION_COUNTER_BYTES,
  maxTotalBytes: MAX_FAULT_INJECTION_COUNTER_BYTES * 256,
  maxFiles: MAX_FAULT_INJECTION_COUNTER_FILES,
};

/* The counters of the corrupted re-run of `namespace`, one per test that saw a corrupted response, below the project directory `e2eDir`: none when it left no counter, and undefined when they cannot be told because a counter could not be used. A counter that holds no number counts for nothing; one whose operation map is out of bounds cannot be used. */
export function readFaultCounters(e2eDir: string, namespace: string, limits: RunOutputLimits = FAULT_INJECTION_COUNTER_LIMITS): FaultCounterRecord[] | undefined {
  return readRunOutputDir(
    { mirrorDir: e2eDir, specDir: e2eDir },
    `.qa/fault-injection/${namespace}`,
    () => true,
    (_name, bytes): FaultCounterRecord => {
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      const corrupted = Number((parsed as { corrupted?: unknown }).corrupted) || 0;
      return { corrupted, ...parseFaultCounterFields(parsed) };
    },
    limits,
  );
}

/* How many responses the corrupted re-run of `namespace` says it corrupted: zero when it left no counter, and undefined when the count cannot be told because a counter could not be used. */
export function countInjectedResponses(e2eDir: string, namespace: string, limits: RunOutputLimits = FAULT_INJECTION_COUNTER_LIMITS): number | undefined {
  return readFaultCounters(e2eDir, namespace, limits)?.reduce((sum, record) => sum + record.corrupted, 0);
}
