import type { RunMode, TestTarget } from "@kernel/run-mode.ts";

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

export type StructuralPattern =
  | { kind: "form"; hasOnSubmit: boolean; hasValidation: boolean }
  | { kind: "api-call"; method: string; hasRequestBody: boolean; hasErrorHandling: boolean }
  | { kind: "stateful-cache"; sourceType: string; hasIndependentWritePath: boolean }
  | { kind: "auth-flow"; hasLogin: boolean; hasSessionToken: boolean }
  | { kind: "data-list"; hasFilter: boolean; hasPagination: boolean; hasEmptyState: boolean }
  | { kind: "generic" };

/* The roles whose step limit a prompt can state: the shell resolves each one from the live agent runtime. */
export type StepLimitRole = "author" | "lead" | "reviewer";

/* Resolves the step limit the agent runtime enforces for a role this run: a positive whole number of steps, or undefined when the runtime enforces none for the role or could not be read. Never rejects. A host that wires no resolver makes no statement: absence, never a stand-in number, is what tells a prompt not to state a limit. */
export type StepLimitFor = (role: StepLimitRole) => Promise<number | undefined>;

export interface ReviewInput {
  diff: string;
  specs: string[];
  /* The suite's existing specs, listed as context only: never judged, never a reason to reject. */
  existingSpecFiles?: string[];
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
  /* On a second round: the spec lines that changed since the reviewer's last rejection. The round is
   * judged against this change plus the prior corrections; unchanged specs are not re-reviewed. */
  specChanges?: string;
  executionResult?: string;
  /* The arms of decisions on changed lines no delivered test ran, as the run's coverage measured them on the bytes under review: the facts a missing-case finding cites. Absent when none was measured or the measurement does not describe these bytes. */
  untakenArms?: { file: string; line: number; kind: string; arm: string }[];
  /* The step limit the runtime enforces for the reviewer's session. Absent = the runtime enforces none or could not be read, and no prompt states one. */
  stepLimit?: number;
}
