import type { ServiceLink, ContractDrift } from "@kernel/service-links.ts";
import type { TestTarget, RunMode } from "@kernel/run-mode.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
import type { Omission } from "@kernel/telemetry/section-meta.ts";
import type { HarnessFacts } from "./harness-facts.ts";
import type { ClosedLoopLimits } from "@kernel/closed-loop.ts";
import type { AgentBrowserLimits } from "@kernel/agent-browser.ts";
import type { GeolocationFacts } from "@kernel/geolocation.ts";
import type { PlanningLimits } from "@kernel/coordination.ts";
import type { ArchitectureContext, CommitIntent } from "./generation-input.ts";

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
  /* The intent lock's violations of the previous turn, as facts: rule, clause, and what the contract held before and after. Absent when the previous turn broke no contract. */
  contractFeedback?: readonly { rule: string; file: string; clauseId: string; before: string; after: string }[];
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
  /* The step limit the runtime enforces for the session this input's prompt is built for: the generator's. Absent = the runtime enforces none or could not be read, and no prompt states one. */
  stepLimit?: number;
  /* The same for the in-generate reviewer's session, a role with a limit of its own. Set only when that reviewer runs. */
  reviewerStepLimit?: number;
  contextPack?: string;
  /* The grounding ids and omissions of the context pack, computed at pack-build time from the kept lines (packDeliveredItemIds). Threaded alongside the pack text so the prompt's delivered span is read from the assembly, never parsed from the text. */
  contextPackItemIds?: readonly string[];
  contextPackOmissions?: readonly Omission[];
  /* Facts about the suite's harness (test-id attribute, fixtures exports), rendered as data only. Absent = no section. */
  harnessFacts?: HarnessFacts;
  /* The limits of the run_spec tool this run granted the generator (calls, time per call, DEV writes), stated as facts. Present only when the run granted it, which only an e2e run on the OpenCode runtime does; absent = no section. */
  closedLoop?: ClosedLoopLimits;
  /* The limits of the authenticated browser this run granted the authoring agents (calls, time per call), stated as facts. Present only when the run granted it, which only an e2e run on the OpenCode runtime does; absent = no section. */
  agentBrowser?: AgentBrowserLimits;
  /* The app's declared location and the location this authoring scope works at, stated as facts. Present only when the app declares geolocation; absent = no section. */
  geolocation?: GeolocationFacts;
  /* Present only on the one turn a coordinated run asks its lead for a plan instead of specs: the limits the plan will be held to. Absent = an ordinary turn, and no section. */
  planning?: PlanningLimits;
  /* App login is declared but <e2eRelDir>/auth.setup.ts is still the stock seed and did not sign in: the generator must rewrite it before writing specs. Absent = nothing to rewrite. */
  authSeedUnauthored?: boolean;
  /* Static signal: deterministic pre-computed analysis rendered as a prompt section. Empty string or absent = no section added. Signal-only, fail-open. */
  staticSignal?: string;
  /* True when the static signal names symbols (impacted or callers): only then does it stand for an explored blast radius. Absent = a signal of co-change files alone (or no signal), which names no blast radius. */
  staticSignalHasSymbols?: boolean;
  /* The files the static signal's dossier shows verbatim (repo-relative): listed as prompt-provided while the section survives. */
  staticSignalFiles?: readonly string[];
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
