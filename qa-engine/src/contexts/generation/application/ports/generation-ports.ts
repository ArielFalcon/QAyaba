/* Canonical generation input types (OpencodeRunInput / ReviewInput). */

import type { TestTarget, RunMode } from "@kernel/run-mode.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
import type { ClosedLoopLimits } from "@kernel/closed-loop.ts";
import type { AgentBrowserLimits } from "@kernel/agent-browser.ts";
import type { PlanningLimits } from "@kernel/coordination.ts";
import type { ServiceLink, ContractDrift } from "@contexts/service-topology/domain/index.ts";
import type { HarnessFacts } from "@contexts/generation/domain/harness-facts.ts";


export type CommitType =
  | "feat" | "fix" | "perf" | "refactor" | "chore"
  | "style" | "docs" | "ci" | "build" | "test" | "revert" | "unknown";

export interface CommitIntent {
  type: CommitType;
  breaking: boolean;
  message: string;
  body?: string;
  changedFiles: string[];
}

export interface RouteEntry {
  path: string;
  name?: string;
  component?: string;
  source?: string;
  /* Repo-relative paths of the files a change to the route's page would touch. Optional: the map loader keeps only well-formed entries (see loadContextMapFromDisk), and route ranking still checks the shape where it reads it. */
  implementationFiles?: string[];
}
export interface ApiOperation {
  operationId: string;
  method: string;
  path: string;
  service?: string;
  spec?: string;
}
export interface FeBeLink {
  route: string;
  operationId: string;
  via?: string;
}
export interface FlowEntry {
  id: string;
  routes: string[];
  operations?: string[];
}
export interface ArchitectureContext {
  builtAtSha: string;
  routes: RouteEntry[];
  api: ApiOperation[];
  feBe: FeBeLink[];
  flows?: FlowEntry[];
}

export interface BlastNode {
  symbol: string;
  file: string;
  role: string;
}
export interface FeBeFact {
  route: string;
  operationId: string;
  via?: string;
}
export interface ContractFact {
  operationId: string;
  method: string;
  path: string;
  fields?: string[];
  errors?: string[];
}
export interface RouteRecon {
  path: string;
  component?: string;
  domLandmarks?: string[];
  verified: boolean; /* DEPRECATED (vestigial: the planner never navigates); retained for backward-compat, never branched on */
}
export interface ExplorationBrief {
  builtForSha: string;
  objective: string;
  blastRadius: BlastNode[];
  feBe?: FeBeFact[];
  contracts?: ContractFact[];
  routes?: RouteRecon[];
  risks?: string[];
  notes?: string;
}

/* The roles whose step limit a prompt can state: the shell resolves each one from the live agent runtime. */
export type StepLimitRole = "generator" | "reviewer" | "explorer";

/* Resolves the step limit the agent runtime enforces for a role this run: a positive whole number of steps, or undefined when the runtime enforces none for the role or could not be read. Never rejects. A host that wires no resolver makes no statement: absence, never a stand-in number, is what tells a prompt not to state a limit. */
export type StepLimitFor = (role: StepLimitRole) => Promise<number | undefined>;

export interface OpencodeRunInput {
  repo: string;
  sha: string;
  diff: string;
  mirrorDir: string;
  e2eRelDir: string;
  namespace: string;
  needsReview: boolean;
  target: TestTarget;
  mode: RunMode;
  appName: string;
  baseUrl?: string;
  intent?: CommitIntent;
  classificationReason?: string;
  contradiction?: boolean;
  guidance?: string;
  openapi?: string | string[];
  fixCases?: QaCase[];
  reviewCorrections?: string[];
  coverageGap?: string;
  selectorContradictions?: string[];
  /* Every spec the run has delivered so far whose file still exists, on a regeneration turn only: the lead's declared flow and objective where it declared them, a sidekick's spec by path alone. Absent on a first pass, and when none is left. What an agent wrote, so the suite listing of the prompt sanitizes and caps it. */
  deliveredSpecs?: readonly DeliveredSpec[];
  /* The specs whose source raised one of `selectorContradictions`, since a contradiction names no file itself: the listing marks them editable. Absent when none could be attributed. */
  attributedSpecFiles?: readonly string[];
  /* Generator render of the retrieved rules: proven rules plus unproven candidates framed as hints. */
  learnedRules?: string;
  /* Reviewer render of the retrieved rules: PROVEN (active) rules only, as reject-on-sight rules. The reviewer is the publish gate, so an unproven candidate must never become grounds for rejection; absent when no proven rule was retrieved. */
  reviewerLearnedRules?: string;
  domSnapshot?: string;
  failureSourced?: boolean;
  runId?: string;
  contextMap?: ArchitectureContext;
  explorer?: boolean;
  /* The step limit the runtime enforces for the session this input's prompt is built for: the generator's, or the explorer's when `explorer` is set. Absent = the runtime enforces none or could not be read, and no prompt states one. */
  stepLimit?: number;
  /* The same for the in-generate reviewer's session, a role with a limit of its own. Set only when that reviewer runs. */
  reviewerStepLimit?: number;
  contextBrief?: ExplorationBrief; /* the distilled blast radius from the explorer pass (set internally → buildPrompt) */
  contextPack?: string;
  /* Facts about the suite's harness (test-id attribute, fixtures exports), rendered as data only. Absent = no section. */
  harnessFacts?: HarnessFacts;
  /* The limits of the run_spec tool this run granted the generator (calls, time per call, DEV writes), stated as facts. Present only when the run granted it, which only an e2e run on the OpenCode runtime does; absent = no section. */
  closedLoop?: ClosedLoopLimits;
  /* The limits of the authenticated browser this run granted the authoring agents (calls, time per call), stated as facts. Present only when the run granted it, which only an e2e run on the OpenCode runtime does; absent = no section. */
  agentBrowser?: AgentBrowserLimits;
  /* Present only on the one turn a coordinated run asks its lead for a plan instead of specs: the limits the plan will be held to. Absent = an ordinary turn, and no section. */
  planning?: PlanningLimits;
  /* App login is declared but <e2eRelDir>/auth.setup.ts is still the stock seed and did not sign in: the generator must rewrite it before writing specs. Absent = nothing to rewrite. */
  authSeedUnauthored?: boolean;
  /* Static signal: deterministic pre-computed analysis rendered as a prompt section. Empty string or absent = no section added. Signal-only, fail-open. */
  staticSignal?: string;
  /* True when the static signal names symbols (impacted or callers): only then does it stand for an explored blast radius. Absent = a signal of co-change files alone (or no signal), which names no blast radius. */
  staticSignalHasSymbols?: boolean;
  skillExemplars?: readonly {
    id: string; name: string; template: string; archetype: string; proven: boolean; promotionCount: number;
  }[];
  existingSpecFiles?: string[];
  service?: { repo: string; mirrorDir: string; openapi?: string | string[] };
  services?: Array<{ repo: string; mirrorDir: string; openapi?: string | string[] }>;
  serviceLinks?: ServiceLink[];
  contractDrift?: ContractDrift[];
  crossRepoImpact?: { impactedLinks: Array<{ link: ServiceLink; tier: string }> };
}

export interface ReviewInput {
  diff: string;
  specs: string[];
  mirrorDir: string;
  e2eRelDir: string;
  baseUrl?: string;
  intent?: CommitIntent;
  guidance?: string;
  appName: string;
  mode: RunMode;
  target?: TestTarget;
  learnedRules?: string;
  /* A DETERMINISTIC snapshot of the live DEV DOM (roles + accessible names of the routes the spec targets), captured by the ORCHESTRATOR — not the generator, so independence holds. It grounds the reviewer's UI-fact claims (labels, button/link text) in reality instead of its training memory of "similar apps", which is what made it hallucinate corrections (e.g. "the button says Add Owner" when DEV says "Submit"). Absent for code mode / when capture is unavailable. */
  domSnapshot?: string;
  runId?: string;
  priorCorrections?: string[];
  executionResult?: string;
  /* The step limit the runtime enforces for the reviewer's session. Absent = the runtime enforces none or could not be read, and no prompt states one. */
  stepLimit?: number;
}
