import type { QaCase } from "@kernel/qa-case.ts";

/**
 * Optional execute bag. Also accepts a bare AbortSignal (normalized to
 * `{ signal }`): AbortSignal is a class instance; the bag is a plain object.
 */
export interface ExecutionOpts {
  signal?: AbortSignal;
  faultInject?: boolean;
  /* The operations a corrupting re-run may touch, as `{ verb, pattern }`; the pass corrupts nothing when it names none. */
  faultOperations?: ReadonlyArray<{ verb: string; pattern: string }>;
  /** Scope re-execution to only the specs that failed. */
  specFiles?: string[];
  /** Attempts after a failure; 0 is a single attempt. Absent: the suite's own config decides. */
  retries?: number;
  /** A title filter, already escaped as a literal. */
  grep?: string;
  /** Have the fixtures count the writes the specs send to DEV; the total comes back as `devWrites`. */
  countWrites?: boolean;
  project?: string;
  timeoutMs?: number;
  /**
   * Live per-case progress so ObserverPort can emit test events during execution
   * instead of reconstructing them after the fact.
   */
  onCase?: (c: QaCase) => void;
  onRunning?: (title: string) => void;
  onDiscovered?: (title: string, file?: string) => void;
  /**
   * Dedicated coverage-dump namespace. Enforce-mode one-shot regen must execute
   * and re-measure under `${runId}-coverage-regen` so dumps never collide with
   * the first run. Absent falls back to the composition-time namespace.
   */
  namespace?: string;
}
