/* The one place a sidekick kind's session is opened by kind: the role and the agent come from the kind's registry entry, never from the caller. */
import type { AgentRuntimePort, AgentSession, OpenSessionOpts } from "@kernel/ports/agent-runtime.port.ts";
import { openSidekickSession } from "@kernel/sidekick-session.ts";
import { sidekickKindSpec, type SidekickKind } from "./sidekick-kinds.ts";

export function openKindSession(runtime: Pick<AgentRuntimePort, "openSession">, kind: SidekickKind, cwd: string, opts: OpenSessionOpts = {}): Promise<AgentSession> {
  return openSidekickSession(runtime, sidekickKindSpec(kind), cwd, opts);
}
