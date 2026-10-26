/*
 * The kinds of sidekick a lead can dispatch. One entry says which agent runs a kind, over which tools, how its brief is rendered,
 * how its answer is read, where it works and what time it may take; a new kind is one entry here, its roster entry and its prompt
 * file. An entry never widens a grant: the roster (`agents/opencode.json`) is the authority and a test holds the two equal.
 */
import type { AgentRole } from "@kernel/agent-role.ts";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import type { DelegationBrief } from "./delegation-brief.ts";
import { readDelegationResult } from "./delegation-reading.ts";
import type { DelegationResult } from "./delegation-result.ts";
import { renderSidekickBrief } from "./sidekick-prompt.ts";

export const SIDEKICK_KIND = { AUTHOR: "author", EXPLORE: "explore", REVIEW: "review" } as const;
export type SidekickKind = (typeof SIDEKICK_KIND)[keyof typeof SIDEKICK_KIND];

/* The capacity a session runs at: the escalated one is a fresh sidekick the lead's review starts on a flow that is stuck. */
export const SIDEKICK_TIER = { STANDARD: "standard", ESCALATED: "escalated" } as const;
export type SidekickTier = (typeof SIDEKICK_TIER)[keyof typeof SIDEKICK_TIER];

/* The tool families a kind may hold. A roster tool maps to one: `write` and `edit` to `write`, `authbrowser_*` to `authbrowser`, `codegraph_explore` to `codegraph`, `playwright*` to `playwright`. */
export const AGENT_TOOL = {
  READ: "read",
  WRITE: "write",
  RUN_SPEC: "run_spec",
  AUTHBROWSER: "authbrowser",
  SET_GEOLOCATION: "set_geolocation",
  CODEGRAPH: "codegraph",
  PLAYWRIGHT: "playwright",
} as const;
export type AgentTool = (typeof AGENT_TOOL)[keyof typeof AGENT_TOOL];

/* Where a kind works: a private copy holding the one spec file it may write, or the run's working copy. */
export const SIDEKICK_WORKSPACE = { ISOLATED_SPEC_FILE: "isolated-spec-file", WORKING_COPY: "working-copy" } as const;
export type SidekickWorkspace = (typeof SIDEKICK_WORKSPACE)[keyof typeof SIDEKICK_WORKSPACE];

/* What bounds a kind's time: the flow budget the plan admitted, the exploration budget, the reviewer's session timeout. `maxSteps` is the roster's. */
export const SIDEKICK_BUDGET = { FLOW: "flow-budget", EXPLORE: "explore-budget", REVIEW: "review-timeout" } as const;
export type SidekickBudget = (typeof SIDEKICK_BUDGET)[keyof typeof SIDEKICK_BUDGET];

export interface SidekickKindSpec {
  readonly id: SidekickKind;
  /* The roster key of the agent that runs the kind. */
  readonly agent: string;
  readonly role: AgentRole;
  readonly tools: readonly AgentTool[];
  /* The capacities the kind may run at. */
  readonly tiers: readonly SidekickTier[];
  readonly workspace: SidekickWorkspace;
  readonly budget: SidekickBudget;
  render(redaction: RedactionPort, brief: DelegationBrief): { text: string; sectionSizes: Record<string, number> };
  parse(redaction: RedactionPort, output: string, brief: DelegationBrief): DelegationResult;
}

const AUTHOR: SidekickKindSpec = {
  id: SIDEKICK_KIND.AUTHOR,
  agent: "qa-sidekick",
  role: "sidekick",
  tools: [AGENT_TOOL.READ, AGENT_TOOL.WRITE, AGENT_TOOL.RUN_SPEC, AGENT_TOOL.AUTHBROWSER, AGENT_TOOL.SET_GEOLOCATION, AGENT_TOOL.PLAYWRIGHT],
  tiers: [SIDEKICK_TIER.STANDARD, SIDEKICK_TIER.ESCALATED],
  workspace: SIDEKICK_WORKSPACE.ISOLATED_SPEC_FILE,
  budget: SIDEKICK_BUDGET.FLOW,
  render: (redaction, brief) => renderSidekickBrief(redaction, brief),
  parse: (redaction, output, brief) => readDelegationResult(output, brief, redaction),
};

const KINDS: Readonly<Partial<Record<SidekickKind, SidekickKindSpec>>> = { [SIDEKICK_KIND.AUTHOR]: AUTHOR };

/* Every kind the registry holds. */
export const REGISTERED_SIDEKICK_KINDS = (): SidekickKindSpec[] => Object.values(KINDS);

export function sidekickKindSpec(kind: SidekickKind): SidekickKindSpec {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`no sidekick kind "${kind}" is registered`);
  return spec;
}
