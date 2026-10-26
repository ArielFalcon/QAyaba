/* The task text of an author sidekick's brief for one flow: the facts about its tools are the orchestrator's; the rest is the flow's own. */
import { formatGeoLocation } from "@kernel/geolocation.ts";
import type { FlowGeolocationHandle, FlowLoopHandle } from "@contexts/agent-tools/application/index.ts";
import type { AdmittedFlow } from "./lead-plan.ts";

/* What a sidekick is told to do for one flow. The facts about its tools are the orchestrator's; the rest is the flow's own. */
export function authorTask(
  flow: AdmittedFlow,
  loop: FlowLoopHandle | undefined,
  browserCallMs: number | undefined,
  geolocation: FlowGeolocationHandle | undefined,
): string {
  const places = geolocation ? Object.keys(geolocation.facts().places).sort() : [];
  const browserUsesLocation = browserCallMs !== undefined && flow.browserCalls > 0 ? " The authenticated browser uses the authoring location." : "";
  return [
    flow.maintenance
      ? `Correct the existing Playwright E2E spec ${flow.writablePaths[0]}. It is the only file you may write; no flow of this run's plan owns it.`
      : `Write the Playwright E2E spec for ONE flow, as the single file ${flow.writablePaths[0]}. It is the only file you may write.`,
    flow.maintenance ? `Flow: ${flow.id}. ${flow.objective}` : `Flow: ${flow.id}. It proves: ${flow.objective}`,
    ...(flow.maintenance ? [flow.maintenance.preamble, ...flow.maintenance.findings.map((finding) => `- ${finding}`)] : []),
    flow.routes.length > 0 ? `Pages it visits: ${flow.routes.join(", ")}` : "",
    geolocation
      ? `Authoring location: ${formatGeoLocation(geolocation.current())}; the app's default is ${formatGeoLocation(geolocation.facts().default)}.${places.length > 0 ? ` Places it declares: ${places.join(", ")}.` : ""}${browserUsesLocation} run_spec and the suite run at the app's default. A spec that depends on a location must call setLocation(context, latitude, longitude) from the suite's fixtures with the coordinates.`
      : "",
    loop
      ? `run_spec: at most ${loop.limits.maxCalls} calls, ${Math.round(loop.limits.perCallMs / 1000)} seconds each, ${loop.limits.maxDevWrites} requests that write to DEV in all. It runs ${flow.writablePaths[0]} and no other file. Run it until it passes, then finish.`
      : "You cannot run the spec: verify it by reading the pages and the grounding.",
    browserCallMs !== undefined && flow.browserCalls > 0
      ? `Authenticated browser: at most ${flow.browserCalls} authbrowser_* calls, ${Math.round(browserCallMs / 1000)} seconds each. It reads DEV as the test account and never writes.`
      : "",
    flow.maintenance
      ? `Finish by emitting the DelegationResult JSON contract from the brief. If you hold the spec right and a finding wrong, change nothing and say why in summary.`
      : `Finish by emitting the DelegationResult JSON contract from the brief. If this flow needs no test of its own, write no file and say why in summary.`,
  ].filter(Boolean).join("\n");
}
