/* Builds the coordination context: the decision ledger every run appends to and, for an e2e run whose shell gave it a place for the sidekicks' workspaces, the lead that plans a change into flows and the sidekicks that author them. A run with no coordinator is authored by its lead alone. */

import type { AgentProvider } from "@kernel/agent-role.ts";
import type { PlanSnapshotPort } from "@kernel/ports/plan-snapshot.port.ts";
import { sanitizedPlanSnapshots } from "@kernel/ports/plan-snapshot.port.ts";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import type { RunDeadlineView } from "@kernel/run-deadline.ts";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import { readConfinedSpecFile } from "../../../shared-infrastructure/spec-path-confinement.ts";
import { systemTimers } from "../application/fan-out-dispatcher.ts";
import { LeadSidekicks } from "../application/lead-sidekicks.ts";
import { SidekickExecutor } from "../application/sidekick-executor.ts";
import type { CoordinationTelemetryPort } from "../application/index.ts";
import { FsDelegationWorkspaceAdapter } from "../infrastructure/adapters/delegation-workspace.adapter.ts";
import { getSharedCoordinationTelemetry } from "../infrastructure/adapters/coordination-telemetry-port.adapter.ts";
import { TracedCoordinationTelemetry } from "../infrastructure/adapters/coordination-telemetry-trace.ts";

/* What the shell hands the builder to let a run author its flows with sidekicks. */
export interface DelegationWiring {
  /* The absolute directory the sidekicks' workspaces are made under (on the mirrors volume, so the agents' runtime can open a session in it). */
  workspaceRoot: string;
  /* The runtime the sidekick role is assigned to now (it is switchable): only OpenCode can call run_spec and the authenticated browser. */
  sidekickProvider: () => AgentProvider | undefined;
  /* The runtime the lead (the primary role) plans on now: only OpenCode can hold the planning turn to read-only. */
  plannerProvider: () => AgentProvider | undefined;
  /* The run's deadline, as the agents' turns read it. */
  deadline?: RunDeadlineView;
}

export interface CoordinationDeps {
  isCode: boolean;
  /* Present: the run is authored with sidekicks. Absent, or a code run: the lead authors alone. */
  delegation?: DelegationWiring;
  /* The runtime the sidekicks open their sessions on (the reviewer's, each with a session of its own). */
  runtime: Pick<AgentRuntimePort, "openSession">;
  /* Where every coordinated free-form string is redacted. */
  redaction: RedactionPort;
  /* The spec file, relative to the spec directory, that a flow's id names (the prompt builders own the name). */
  specFileFor: (flowId: string) => string;
  /* The run's code graph and the repository it indexes: an explore finding that names a symbol is verified against it. */
  codeGraph?: CodeGraphPort;
  codeGraphRepoDir?: string;
  /* The outbound sanitizer for the plan a run keeps; with `planSnapshots`, otherwise nothing is kept. */
  sanitize?: (text: string) => string;
  planSnapshots?: PlanSnapshotPort;
  /* The model a fresh sidekick the lead's review starts on a flow runs with. */
  escalatedModel?: string;
  /* Durable JSONL sink for the decision ledger; absent: memory-only. */
  telemetryPath?: string;
  telemetry?: TelemetryPort;
}

export interface CoordinationApi {
  coordinationTelemetry: CoordinationTelemetryPort;
  leadSidekicks?: LeadSidekicks;
  sidekickProvider?: () => AgentProvider | undefined;
  plannerProvider?: () => AgentProvider | undefined;
}

export function buildCoordination(deps: CoordinationDeps): CoordinationApi {
  /* Process-lifetime store, so the ledger of decisions outlives a run (not a fresh empty bag per build). */
  const ledger = deps.telemetryPath ? getSharedCoordinationTelemetry(deps.telemetryPath) : getSharedCoordinationTelemetry();
  const coordinationTelemetry = deps.telemetry ? new TracedCoordinationTelemetry(ledger, deps.telemetry) : ledger;
  const { delegation } = deps;
  if (!delegation || deps.isCode) return { coordinationTelemetry };
  return {
    coordinationTelemetry,
    sidekickProvider: delegation.sidekickProvider,
    plannerProvider: delegation.plannerProvider,
    leadSidekicks: new LeadSidekicks({
      redaction: deps.redaction,
      sidekick: new SidekickExecutor({ runtime: deps.runtime, redaction: deps.redaction }),
      workspaces: new FsDelegationWorkspaceAdapter({ root: delegation.workspaceRoot }),
      timers: systemTimers,
      telemetry: coordinationTelemetry,
      ...(deps.planSnapshots && deps.sanitize ? { planSnapshots: sanitizedPlanSnapshots(deps.planSnapshots, deps.sanitize) } : {}),
      specFileFor: deps.specFileFor,
      ...(deps.codeGraph && deps.codeGraphRepoDir ? { graphHolds: (ref) => graphHoldsSymbol(deps.codeGraph!, deps.codeGraphRepoDir!, ref) } : {}),
      /* What a sidekick wrote is untrusted: the lead's review reads it through the confined reader, and an unreadable spec is shown as none. */
      readSpec: async (root, specFile) => {
        try {
          return readConfinedSpecFile(root, specFile);
        } catch {
          return undefined;
        }
      },
      ...(deps.escalatedModel ? { escalatedModel: deps.escalatedModel } : {}),
      ...(delegation.deadline ? { deadline: delegation.deadline } : {}),
    }),
  };
}

/* A symbol ref is `<repo-relative file>#<symbol>`: the graph holds it when it finds that symbol in that file; a bare name is held when a route points at a symbol of that name. Any answer but a clear yes is no. */
export async function graphHoldsSymbol(codeGraph: CodeGraphPort, repoDir: string, ref: string): Promise<boolean> {
  const at = ref.indexOf("#");
  if (at > 0 && at < ref.length - 1) {
    const found = await codeGraph.callersOf(repoDir, [{ file: ref.slice(0, at), symbol: ref.slice(at + 1) }], { depth: 0, maxSymbols: 1 });
    return found.ok && found.value.symbols.some((s) => s.file === ref.slice(0, at) && s.symbol === ref.slice(at + 1));
  }
  const routes = await codeGraph.routes(repoDir);
  return routes.ok && routes.value.some((route) => route.target?.symbol === ref);
}
