import type { HostEventListener } from "../../domain/run-trace.ts";

/** Who hears what the host did to the process (a suspend, a blocked event loop). The run's root span registers itself for the length of the run. */
export interface HostEventsPort {
  /** Returns the function that removes the listener; calling it twice is harmless. */
  add(listener: HostEventListener): () => void;
}
