import type { TriggerSource } from "@kernel/run-mode.ts";

/*
 * The source a run's engine input carries, for a door that tells the trigger: only a deploy's webhook is "webhook" (the engine's
 * deploy-triggered run); a control-API run, whoever sent it, is "manual", so a campaign replicate or a replay never waits for a deploy.
 */
export function sourceOfTrigger(trigger: "api" | "webhook"): TriggerSource {
  return trigger === "webhook" ? "webhook" : "manual";
}
