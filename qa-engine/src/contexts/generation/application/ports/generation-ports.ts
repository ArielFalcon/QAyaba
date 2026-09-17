/* Canonical generation input types (OpencodeRunInput / ReviewInput / ParallelWorkerInput). */

import type { TestTarget, RunMode } from "@kernel/run-mode.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { ServiceLink, ContractDrift } from "@contexts/service-topology/domain/index.ts";


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

export type StructuralPattern =
  | { kind: "form"; hasOnSubmit: boolean; hasValidation: boolean }
  | { kind: "api-call"; method: string; hasRequestBody: boolean; hasErrorHandling: boolean }
  | { kind: "stateful-cache"; sourceType: string; hasIndependentWritePath: boolean }
  | { kind: "auth-flow"; hasLogin: boolean; hasSessionToken: boolean }
  | { kind: "data-list"; hasFilter: boolean; hasPagination: boolean; hasEmptyState: boolean }
  | { kind: "generic" };

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
  verified: boolean; /* DEPRECATED (vestigial after F3); retained for backward-compat, never branched on */
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
  learnedRules?: string;
  domSnapshot?: string;
  failureSourced?: boolean;
  runId?: string;
  contextMap?: ArchitectureContext;
  explorer?: boolean;
  contextBrief?: ExplorationBrief; /* the distilled blast radius from the explorer pass (set internally → buildPrompt) */
  contextPack?: string;
  /* Static signal: deterministic pre-computed analysis rendered as a prompt section. Empty string or absent = no section added. Signal-only, fail-open. */
  staticSignal?: string;
  diffArchetypes?: string[];
  /* Fed into prompts.ts's matchExemplars/renderExemplarsForPrompt loop to render a "Skill exemplars" section. Absent or empty = no section (never fabricated). Restoration-only: no live production caller populates this yet (mirrors diffArchetypes' own still-open wiring gap into the rewritten engine). */
  structuralPatterns?: StructuralPattern[];
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
  objective?: string;
  priorCorrections?: string[];
  executionResult?: string;
}

export interface ParallelWorkerInput {
  objective: string;
  flow: string;
  symbols: string[];
  needsUi: boolean;
  brief?: ExplorationBrief;
  specFile: string;
  repo: string;
  mirrorDir: string;
  e2eRelDir: string;
  namespace: string;
  baseUrl?: string;
  appName: string;
  mode: RunMode;
  learnedRules?: string;
  domSnapshot?: string;
  runId?: string;
  staticSignal?: string; /* deterministic pre-computed analysis (signal-only, fail-open) */
  serviceLinks?: ServiceLink[];
  contractDrift?: ContractDrift[];
  crossRepoImpact?: { impactedLinks: Array<{ link: ServiceLink; tier: string }> };
}
