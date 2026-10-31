import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { RunInput } from "../../domain/run-input.ts";

export interface RunPipelinePort {
  /**
   * `signal` is a separate transport argument, not a RunInput field: queue
   * cancellation is orthogonal to which run is requested. A cancelled run must
   * stop rather than resolve late and overwrite a finalized record.
   */
  run(input: RunInput, signal?: AbortSignal): Promise<RunOutcome>;
}
