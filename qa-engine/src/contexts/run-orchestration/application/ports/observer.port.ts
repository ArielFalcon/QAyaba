import type { RunStep } from "@kernel/run-step.ts";
import type { RunEventBody } from "@contexts/run-orchestration/domain/run-event.ts";

/** Replaces positional run callbacks with one typed observer. */
export interface ObserverPort {
  onStep(step: RunStep, detail?: string): void;
  onEvent(body: RunEventBody): void;
}
