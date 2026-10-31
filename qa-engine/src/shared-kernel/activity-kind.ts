/* Shared kernel: the kind of one entry of a run's live activity list. The agent transport (generation) produces the entries, the history store keeps them and the control API serves them; this is the one list of kinds they all read. It is not the kind of an `agent.activity` run event (`AgentActivityKind` in qa-engine/src/shared-kernel/contract/events.ts). */

export const ACTIVITY_KINDS = ["file", "command", "todo", "phase", "error"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
