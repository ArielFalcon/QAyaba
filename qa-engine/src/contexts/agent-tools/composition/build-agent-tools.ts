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
import { SessionCheckAdapter } from "../infrastructure/adapters/session-check.adapter.ts";
import type { SessionCheckPort } from "@contexts/test-execution/application/index.ts";
import type { ToolTraceWiring } from "../infrastructure/adapters/tool-call-trace.ts";

/* What the shell hands the builder to let a run grant its generator the run_spec tool. */
export type ClosedLoopWiring = Omit<ClosedLoopPortAdapterDeps, "execution" | "cleanup" | "authSession" | "authContext" | "specRelDir" | "trace" | "now">;

/* What the shell hands the builder to let a run grant its authoring agents the authenticated browser. */
export type AgentBrowserWiring = Omit<AgentBrowserPortAdapterDeps, "baseUrl" | "material" | "authSession" | "authContext" | "trace" | "now">;

/* What the shell hands the builder to let a run grant the lead the code-graph tools. */
export type CodeGraphToolsWiring = Omit<CodeGraphToolsPortAdapterDeps, "explore" | "repos" | "trace">;

/* What the shell hands the builder to let a run carry its authoring location. */
export type GeolocationWiring = GeolocationPortAdapterDeps;

export interface AgentToolsDeps {
  run: {
    baseUrl?: string;
    /* The spec directory relative to the mirror. */
    specRelDir: string;
    /* The repository the run's code index was built from. */
    codeGraphRepoDir: string;
    /* Every repository of the run's change with its mirror, in entry order; absent, the run's code index repo alone. */
    codeGraphRepos?: ReadonlyArray<{ repo: string; repoDir: string }>;
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
  /* The orchestrator's check of the run's saved session, on the authenticated browser's machinery; built wherever that machinery is wired, whether or not the app grants the browser to its agents. */
  sessionCheck?: SessionCheckPort;
}

export function buildAgentTools(deps: AgentToolsDeps): AgentToolsApi {
  const { run } = deps;
  const trace: ToolTraceWiring | undefined = deps.telemetry
    ? { telemetry: deps.telemetry, clock: deps.clock ?? { now: () => Date.now() }, ...(deps.toolAttempts ? { attempts: deps.toolAttempts } : {}) }
    : undefined;
  const authContext = deps.authSession && run.baseUrl ? { baseUrl: run.baseUrl, ...(run.auth ? { auth: run.auth } : {}) } : undefined;

  const closedLoop =
    deps.closedLoop
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
    deps.agentBrowser && baseUrl
      ? new AgentBrowserPortAdapter({
          ...deps.agentBrowser,
          ...(trace ? { trace } : {}),
          baseUrl,
          material: () => readAgentBrowserSession(baseUrl),
          ...(deps.authSession ? { authSession: deps.authSession, authContext: { baseUrl, ...(run.auth ? { auth: run.auth } : {}) } } : {}),
        })
      : undefined;

  /* The run's judging executions ask it whether the session they were given is still one the app accepts (RFC-0015, ADR-0023 row 8). */
  const sessionCheck =
    deps.agentBrowser && baseUrl
      ? new SessionCheckAdapter({
          baseUrl,
          launcher: deps.agentBrowser.launcher,
          createHost: deps.agentBrowser.createHost,
          material: () => readAgentBrowserSession(baseUrl),
          denyRoutes: deps.agentBrowser.setting.denyRoutes,
          account: deps.agentBrowser.account,
          lock: deps.agentBrowser.lock,
          ...(deps.agentBrowser.loginPath !== undefined ? { loginPath: deps.agentBrowser.loginPath } : {}),
        })
      : undefined;

  /* The lead explores the index the index phase built for the run's repo; it names terms, never the repo, the workspace or the engine's options. */
  const codeGraphTools =
    deps.codeGraphTools && deps.codeExplore
      ? new CodeGraphToolsPortAdapter({ ...deps.codeGraphTools, explore: deps.codeExplore, repos: run.codeGraphRepos?.length ? run.codeGraphRepos : [{ repo: "", repoDir: run.codeGraphRepoDir }], ...(trace ? { trace } : {}) })
      : undefined;

  /* The app's declared position, the lead's value and one per flow: authoring context, never an input to the delivered suite. */
  const geolocation = deps.geolocation ? new GeolocationPortAdapter(deps.geolocation) : undefined;

  return {
    ...(closedLoop ? { closedLoop } : {}),
    ...(agentBrowser ? { agentBrowser } : {}),
    ...(codeGraphTools ? { codeGraphTools } : {}),
    ...(geolocation ? { geolocation } : {}),
    ...(sessionCheck ? { sessionCheck } : {}),
  };
}
