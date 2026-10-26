import type { ClosedLoopHandle, ClosedLoopOpenInput } from "../../domain/closed-loop.ts";

export interface ClosedLoopPort {
  /** Resolves undefined when this run is not granted the loop (disabled, another runtime, nothing to run it with). */
  open(input: ClosedLoopOpenInput): Promise<ClosedLoopHandle | undefined>;
}
