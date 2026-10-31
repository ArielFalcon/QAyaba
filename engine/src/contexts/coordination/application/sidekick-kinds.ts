/*
 * The kinds of sidekick a lead can dispatch. One entry says which agent runs a kind, over which tools, how its brief is rendered,
 * how its answer is read, where it works and what time it may take; a new kind is one entry here, its roster entry and its prompt
 * file. An entry never widens a grant: the roster (`agents/opencode.json`) is the authority and a test holds the two equal.
 */
import type { AgentRole } from "@kernel/agent-role.ts";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import type { WindowFitOutcome } from "@kernel/prompt-sections.ts";
import type { DelegationBrief } from "./delegation-brief.ts";
import { readDelegationResult } from "./delegation-reading.ts";
import type { DelegationResult } from "./delegation-result.ts";
import type { DevStateGround } from "./dev-state-backing.ts";
import { renderSidekickBrief } from "./sidekick-prompt.ts";
import { AUTHOR_SIDEKICK, REVIEW_SIDEKICK } from "@kernel/sidekick-session.ts";

export const SIDEKICK_KIND = { AUTHOR: "author", REVIEW: "review" } as const;
export type SidekickKind = (typeof SIDEKICK_KIND)[keyof typeof SIDEKICK_KIND];

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

/* What bounds a kind's time: the flow budget the plan admitted, the run's own deadline and its tier budget for an author of the whole run, the reviewer's session timeout. `maxSteps` is the roster's. */
export const SIDEKICK_BUDGET = { FLOW: "flow-budget", RUN: "run-deadline", REVIEW: "review-timeout" } as const;
export type SidekickBudget = (typeof SIDEKICK_BUDGET)[keyof typeof SIDEKICK_BUDGET];

interface SidekickKindBase {
  readonly id: SidekickKind;
  /* The roster key of the agent that runs the kind. */
  readonly agent: string;
  readonly role: AgentRole;
  readonly tools: readonly AgentTool[];
  readonly workspace: SidekickWorkspace;
  readonly budget: SidekickBudget;
}

/* A kind the lead briefs for one flow: the brief is a `DelegationBrief` and the answer a `DelegationResult`. */
export interface DelegatingKindSpec extends SidekickKindBase {
  readonly id: typeof SIDEKICK_KIND.AUTHOR;
  /* `fit` is the window fit rule of the model the session runs on: a brief over it gives its degradable sections up as references. */
  render(redaction: RedactionPort, brief: DelegationBrief, fit?: (bytes: number) => WindowFitOutcome): { text: string; sectionSizes: Record<string, number>; stablePrefixBytes?: number };
  /* `ground` is what the orchestrator holds of the flow, for the claims an answer makes about DEV's state; a kind that makes none ignores it. */
  parse(redaction: RedactionPort, output: string, brief: DelegationBrief, ground?: DevStateGround): DelegationResult;
}

/* The independent review: the orchestrator dispatches it and its verdict is the publish gate. Its brief and its answer are the review port's: the prompt rendering port renders the reviewer's input and the verdict parser port reads its verdict, both injected into the adapter that opens the session (the generation context owns that port and cannot depend on this one). */
export interface ReviewKindSpec extends SidekickKindBase {
  readonly id: typeof SIDEKICK_KIND.REVIEW;
}

export type SidekickKindSpec = DelegatingKindSpec | ReviewKindSpec;

const AUTHOR: DelegatingKindSpec = {
  id: SIDEKICK_KIND.AUTHOR,
  ...AUTHOR_SIDEKICK,
  tools: [AGENT_TOOL.READ, AGENT_TOOL.WRITE, AGENT_TOOL.RUN_SPEC, AGENT_TOOL.AUTHBROWSER, AGENT_TOOL.SET_GEOLOCATION, AGENT_TOOL.PLAYWRIGHT],
  workspace: SIDEKICK_WORKSPACE.ISOLATED_SPEC_FILE,
  budget: SIDEKICK_BUDGET.FLOW,
  render: (redaction, brief, fit) => renderSidekickBrief(redaction, brief, fit),
  parse: (redaction, output, brief, ground) => readDelegationResult(output, brief, redaction, ground),
};

/*
 * What an author works on. A `flow` is one flow of a plan, in a private copy that holds the one spec file it may write. The other
 * targets are the run's own authoring, by one author in the run's working copy under the run's deadline and effort tier: `e2e`
 * (a login still to be written, and every regeneration of an e2e run) and `context` (the architecture map). A target changes where the author works and what bounds it, never what it may use: the roster's grant is the kind's.
 */
export const AUTHOR_TARGET = { FLOW: "flow", E2E: "e2e", CONTEXT: "context" } as const;
export type AuthorTarget = (typeof AUTHOR_TARGET)[keyof typeof AUTHOR_TARGET];

export interface AuthorTargetSpec {
  readonly workspace: SidekickWorkspace;
  readonly budget: SidekickBudget;
}

const RUN_AUTHORING: AuthorTargetSpec = { workspace: SIDEKICK_WORKSPACE.WORKING_COPY, budget: SIDEKICK_BUDGET.RUN };

const AUTHOR_TARGETS: Readonly<Record<AuthorTarget, AuthorTargetSpec>> = {
  [AUTHOR_TARGET.FLOW]: { workspace: SIDEKICK_WORKSPACE.ISOLATED_SPEC_FILE, budget: SIDEKICK_BUDGET.FLOW },
  [AUTHOR_TARGET.E2E]: RUN_AUTHORING,
  [AUTHOR_TARGET.CONTEXT]: RUN_AUTHORING,
};

export const authorTargetSpec = (target: AuthorTarget): AuthorTargetSpec => AUTHOR_TARGETS[target];

const REVIEW: ReviewKindSpec = {
  id: SIDEKICK_KIND.REVIEW,
  ...REVIEW_SIDEKICK,
  tools: [AGENT_TOOL.READ],
  workspace: SIDEKICK_WORKSPACE.WORKING_COPY,
  budget: SIDEKICK_BUDGET.REVIEW,
};

const KINDS: Readonly<Partial<Record<SidekickKind, SidekickKindSpec>>> = { [SIDEKICK_KIND.AUTHOR]: AUTHOR, [SIDEKICK_KIND.REVIEW]: REVIEW };

/* Every kind the registry holds. */
export const REGISTERED_SIDEKICK_KINDS = (): SidekickKindSpec[] => Object.values(KINDS);

export function sidekickKindSpec(kind: SidekickKind): SidekickKindSpec {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`no sidekick kind "${kind}" is registered`);
  return spec;
}

/* The kinds the lead briefs for a flow; any other kind has no brief to render. */
export function delegatingKindSpec(kind: SidekickKind): DelegatingKindSpec {
  const spec = sidekickKindSpec(kind);
  if (spec.id === SIDEKICK_KIND.REVIEW) throw new Error(`the sidekick kind "${kind}" is not briefed by the lead`);
  return spec;
}
