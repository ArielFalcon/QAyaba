/* Builds the agent-tools context: the tools a run may grant its authoring agents (run_spec, the authenticated browser, the code-graph tools, the authoring location). Each is optional and never stubbed: a tool is built only for an e2e run whose shell supplied its wiring, and a run without it grants nothing. */

import type { TelemetryClock, TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import type { CodeExplorePort } from "@kernel/ports/code-explore.port.ts";
import type { AuthDeclaration, AuthSessionPort } from "@contexts/app-catalog/application/index.ts";
import type { AgentBrowserPort, ClosedLoopCleanupPort, ClosedLoopExecutionPort, ClosedLoopPort, CodeGraphToolsPort, GeolocationPort } from "../application/index.ts";
import { AgentBrowserPortAdapter, type AgentBrowserPortAdapterDeps } from "../infrastructure/adapters/agent-browser-port.adapter.ts";
import { readAgentBrowserSession } from "../infrastructure/adapters/agent-browser-session-material.ts";
import { ClosedLoopPortAdapter, type ClosedLoopPortAdapterDeps } from "../infrastructure/adapters/closed-loop-port.adapter.ts";
import { CodeGraphToolsPortAdapter, type CodeGraphToolsPortAdapterDeps } from "../infrastructure/adapters/code-graph-tools-port.adapter.ts";
import { GeolocationPortAdapter, type GeolocationPortAdapterDeps } from "../infrastructure/adapters/geolocation-port.adapter.ts";
import type { ToolTraceWiring } from "../infrastructure/adapters/tool-call-trace.ts";

/* What the shell hands the builder to let a run grant its generator the run_spec tool. */
export type ClosedLoopWiring = Omit<ClosedLoopPortAdapterDeps, "execution" | "cleanup" | "authSession" | "authContext" | "specRelDir" | "trace" | "now">;

/* What the shell hands the builder to let a run grant its authoring agents the authenticated browser. */
export type AgentBrowserWiring = Omit<AgentBrowserPortAdapterDeps, "baseUrl" | "material" | "authSession" | "authContext" | "trace" | "now">;

/* What the shell hands the builder to let a run grant the lead the code-graph tools. */
export type CodeGraphToolsWiring = Omit<CodeGraphToolsPortAdapterDeps, "explore" | "repoDir" | "trace">;

/* What the shell hands the builder to let a run carry its authoring location. */
export type GeolocationWiring = GeolocationPortAdapterDeps;

export interface AgentToolsDeps {
  run: {
    isCode: boolean;
    baseUrl?: string;
    /* The spec directory relative to the mirror. */
    specRelDir: string;
    /* The repository the run's code index was built from. */
    codeGraphRepoDir: string;
    auth?: AuthDeclaration;
  };
  /* The run's own execution and cleanup ports: a spec the loop runs is run exactly as the suite's are. */
  execution: ClosedLoopExecutionPort;
  cleanup?: ClosedLoopCleanupPort;
  authSession?: AuthSessionPort;
  /* The engine's answers over the same index the run built. */
  codeExplore?: CodeExplorePort;
  closedLoop?: ClosedLoopWiring;
  agentBrowser?: AgentBrowserWiring;
  codeGraphTools?: CodeGraphToolsWiring;
  geolocation?: GeolocationWiring;
  /* With telemetry, every served call is a span under the attempt of the session that made it. */
  telemetry?: TelemetryPort;
  clock?: TelemetryClock;
  toolAttempts?: ToolTraceWiring["attempts"];
}

export interface AgentToolsApi {
  closedLoop?: ClosedLoopPort;
  agentBrowser?: AgentBrowserPort;
  codeGraphTools?: CodeGraphToolsPort;
  geolocation?: GeolocationPort;
}

export function buildAgentTools(deps: AgentToolsDeps): AgentToolsApi {
  const { run } = deps;
  const trace: ToolTraceWiring | undefined = deps.telemetry
    ? { telemetry: deps.telemetry, clock: deps.clock ?? { now: () => Date.now() }, ...(deps.toolAttempts ? { attempts: deps.toolAttempts } : {}) }
    : undefined;
  const authContext = deps.authSession && run.baseUrl ? { baseUrl: run.baseUrl, ...(run.auth ? { auth: run.auth } : {}) } : undefined;

  const closedLoop =
    deps.closedLoop && !run.isCode
      ? new ClosedLoopPortAdapter({
          ...deps.closedLoop,
          ...(trace ? { trace } : {}),
          execution: deps.execution,
          ...(deps.cleanup ? { cleanup: deps.cleanup } : {}),
          ...(authContext && deps.authSession ? { authSession: deps.authSession, authContext } : {}),
          specRelDir: run.specRelDir,
        })
      : undefined;

  /* The browser reads DEV through the run's own session and origins; a spec is never run by it. */
  const baseUrl = run.baseUrl;
  const agentBrowser =
    deps.agentBrowser && !run.isCode && baseUrl
      ? new AgentBrowserPortAdapter({
          ...deps.agentBrowser,
          ...(trace ? { trace } : {}),
          baseUrl,
          material: () => readAgentBrowserSession(baseUrl),
          ...(deps.authSession ? { authSession: deps.authSession, authContext: { baseUrl, ...(run.auth ? { auth: run.auth } : {}) } } : {}),
        })
      : undefined;

  /* The lead explores the index the index phase built for the run's repo; it names terms, never the repo, the workspace or the engine's options. */
  const codeGraphTools =
    deps.codeGraphTools && deps.codeExplore && !run.isCode
      ? new CodeGraphToolsPortAdapter({ ...deps.codeGraphTools, explore: deps.codeExplore, repoDir: run.codeGraphRepoDir, ...(trace ? { trace } : {}) })
      : undefined;

  /* The app's declared position, the lead's value and one per flow: authoring context, never an input to the delivered suite. */
  const geolocation = deps.geolocation && !run.isCode ? new GeolocationPortAdapter(deps.geolocation) : undefined;

  return {
    ...(closedLoop ? { closedLoop } : {}),
    ...(agentBrowser ? { agentBrowser } : {}),
    ...(codeGraphTools ? { codeGraphTools } : {}),
    ...(geolocation ? { geolocation } : {}),
  };
}
