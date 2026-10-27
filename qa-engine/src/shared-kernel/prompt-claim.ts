/* What a prompt section declares about itself for the prompt-contract lint: the fact it provides, how it frames that fact's trust, what it directs the agent to do about a fact, and, for a delegation brief, which part of the brief's contract it states and what it says the turn grants. The shape is the only thing the lint reads. */

export type FactId =
  | "blast-radius"
  | "fe-be-links"
  | "api-operations"
  | "dom-live"
  | "dom-failure"
  | "changed-values"
  | "arch-map"
  | "structural-signal"
  | "co-change"
  | "service-links"
  | "harness-facts"
  | "step-limit"
  | "closed-loop"
  | "agent-browser"
  | "geolocation"
  | "lead-plan"
  | "existing-suite"
  | "learned-rules"
  | "exemplars"
  | "diff"
  /* The orchestrator, not the agent, compiles and runs what a code run writes. */
  | "orchestrator-validation"
  /* A failure of the static gate (compile, lint), which nothing executed. */
  | "gate-failure"
  /* The bounded snapshot of a service's contracts a cross-repo run reads instead of the service's source. */
  | "staged-service-snapshot"
  /* The reviewer's reply is one bare JSON object, and an empty corrections list beside an approval is a complete answer. */
  | "bare-json-reply"
  | "empty-corrections-valid"
  /* The reviewer's specs section holds the spec contents themselves, not only the names of the files. */
  | "spec-contents-inline";

export type ClaimAction =
  | "read"
  | "consult"
  | "orient"
  | "analyze-repo"
  | "state-outcome"
  | "derive-from-code"
  | "use-runtime-signals"
  /* The way out for a route the injected grounding does not cover. */
  | "use-browser-for-uncovered-route";

/* The four parts of a delegation brief's contract: what the sidekick is for, the shape of its answer, what it may write and must not do, and the tools it holds. */
export type BriefContractPart = "objective" | "return-shape" | "boundary" | "tools";

export const BRIEF_CONTRACT_PARTS: readonly BriefContractPart[] = ["objective", "return-shape", "boundary", "tools"];

export type PromptClaim =
  | { kind: "provides"; fact: FactId }
  | { kind: "frames"; fact: FactId; as: "established" | "unverified" }
  | { kind: "directs"; action: ClaimAction; target?: FactId }
  /* The section is where the brief states this part of its contract. */
  | { kind: "states-contract"; part: BriefContractPart }
  /* The section says the turn holds this tool. */
  | { kind: "states-tool"; tool: string }
  /* The section says the turn may write files. */
  | { kind: "states-write" };
