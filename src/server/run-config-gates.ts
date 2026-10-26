/*
 * The two conditions that decide what a run is wired with and that its effectiveConfig must report: one definition each, used by the
 * engine factory (what is wired) and by resolveRunConfig (what is recorded), so the record cannot drift from the wiring.
 */
import type { TestTarget } from "@kernel/run-mode";
import type { AppConfig } from "../orchestrator/config-loader";

/* The run_spec loop and the authenticated browser exist only for an e2e run of an app with a DEV address. */
export function toolsApply(target: TestTarget, app: Pick<AppConfig, "dev">): boolean {
  return target !== "code" && Boolean(app.dev?.baseUrl);
}

/* The service-topology collaborator and cross-repo impact (the "stitcher") are wired only for an app with services and declared boundaries. */
export function serviceTopologyWired(app: Pick<AppConfig, "services" | "boundaries">): boolean {
  return (app.services?.length ?? 0) > 0 && (app.boundaries?.length ?? 0) > 0;
}
