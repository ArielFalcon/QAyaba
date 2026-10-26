/* How a sidekick's session is opened: the role and the agent come from the sidekick's identity, never from the caller. The identity of each kind lives in the coordination context's registry (`sidekick-kinds.ts`); the review's is here as well because the review port, which a context that cannot depend on coordination owns, opens its session through it. */
import type { AgentRole } from "./agent-role.ts";
import type { AgentRuntimePort, AgentSession, OpenSessionOpts } from "./ports/agent-runtime.port.ts";

export interface SidekickIdentity {
  /* The roster key of the agent. */
  readonly agent: string;
  readonly role: AgentRole;
}

export const REVIEW_SIDEKICK: SidekickIdentity = { agent: "qa-reviewer", role: "reviewer" };

export function openSidekickSession(runtime: Pick<AgentRuntimePort, "openSession">, identity: SidekickIdentity, cwd: string, opts: OpenSessionOpts = {}): Promise<AgentSession> {
  return runtime.openSession(identity.role, cwd, { ...opts, descriptor: { ...opts.descriptor, role: identity.agent } });
}
