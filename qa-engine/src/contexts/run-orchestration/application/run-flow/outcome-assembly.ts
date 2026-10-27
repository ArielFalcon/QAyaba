/*
 * How a run's record is assembled: the error class a verdict resolves to, the outcome a run persists for its decision, and the narrow
 * view of that outcome the reflector learns from. One place, so every way a run ends describes itself in the same terms.
 */

import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { ClosedLoopGateSignal } from "@kernel/closed-loop.ts";
import type { AgentBrowserGateSignal } from "@kernel/agent-browser.ts";
import type { GenerationEndKind } from "@kernel/generation-end.ts";
import type { NoopKind } from "@kernel/noop-kind.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { ReflectionInput } from "@contexts/cross-run-learning/application/index.ts";
import { resolveErrorClass } from "@kernel/error-class.ts";
import type { RunDecision } from "../../domain/run-decision.ts";
import type { RunContext } from "./run-context.ts";

/* Same minRatio the coverage policy uses for the E-COVERAGE-GAP band. */
const DEFAULT_MIN_COVERAGE_RATIO = 0.7;

/*
 * What a persisted outcome may carry beyond the decision. reviewerApproved, valueScore and rulesRetrieved are optional: early exits
 * never reached those phases and must not fabricate them. Pre-exec counters default to 0 (not undefined) when the gate never ran.
 */
export interface OutcomeExtras {
  /* Only callers whose path genuinely passed the static gate thread true; default is false. */
  staticOk?: boolean;
  reviewerApproved?: boolean;
  /* Only the mainline post-review caller threads real corrections; others get []. */
  reviewerCorrections?: string[];
  /* Only the marker-scoped reviewer-unavailable exit threads a rationale. */
  reviewerRationale?: string;
  /* What the review phase cost and decided; absent when no reviewer phase ran. */
  reviewer?: RunOutcome["gateSignals"]["reviewer"];
  valueScore?: number | null;
  /* Same "never ran" (absent) vs "ran and found zero" distinction as the sibling counts below. */
  mutantCount?: number;
  killedCount?: number;
  branchCoverage?: RunOutcome["gateSignals"]["branchCoverage"];
  changeCoverage?: RunOutcome["gateSignals"]["changeCoverage"];
  bundleMutation?: RunOutcome["gateSignals"]["bundleMutation"];
  branchCases?: RunOutcome["gateSignals"]["branchCases"];
  survivorClosure?: RunOutcome["gateSignals"]["survivorClosure"];
  flakyTriage?: RunOutcome["gateSignals"]["flakyTriage"];
  missingCases?: string[];
  note?: string;
  rulesRetrieved?: string[];
  diffArchetypes?: string[];
  preExecAmbiguityCatches?: number;
  deterministicSelectorBlocks?: number;
  catalogGateInWindow?: number;
  catalogGateAdvisory?: number;
  catalogGateFailClosed?: number;
  /* Optional telemetry. Construction uses conditional-spread, not `?? 0`. */
  structuralSignalBytes?: number;
  serviceLinksCount?: number;
  contractDriftCount?: number;
  /* Same "never ran" vs "ran and found zero" distinction as the sibling counts. */
  crossRepoImpactedCount?: number;
  /* Only the mainline post-execute caller has real logs. */
  logs?: string;
  /* Only the mainline post-FixLoop caller has a real adjudication class. */
  adjudicationClass?: string;
  /* Omitted entirely when confinement never ran — never a fabricated {strays:0}. */
  confinement?: { strays: number; dangerous: number; reverted: string[] };
  /* Absent when the run did not grant the run_spec tool. */
  closedLoop?: ClosedLoopGateSignal;
  /* Absent when the run did not grant the authenticated agent browser. */
  agentBrowser?: AgentBrowserGateSignal;
  /* The recorded coverage predates the bytes an accepted regeneration wrote (signal mode reuses it). */
  coverage?: { stale: boolean };
  /* The recorded value score has the same staleness; the oracle stays signal-only. */
  value?: { stale: boolean };
  /* What the run's regeneration acceptance did; absent when no regeneration came through it. */
  integrity?: { acceptances: number; rejected: number; proofReused: number; capHit: boolean };
  /* The test-intent lock's derived clauses and deltas; absent when the lock is off or nothing was derived. */
  intent?: { mode: string; violations: number; wouldReject: number; clauses: number; opaque: number; opacityHigh: boolean };
  /* The kind a declared no-op named; absent for every run that is not one. */
  noop?: { kind: NoopKind };
  /* Per use case change-coverage; absent when no use case was asked for. */
  coverageByCandidate?: RunOutcome["gateSignals"]["coverageByCandidate"];
  /* Per use case fault-injection score; absent when the oracle was not aimed at any. */
  valueByCandidate?: RunOutcome["gateSignals"]["valueByCandidate"];
  /* What the corrupted re-run counted; absent when it measured nothing. */
  valueStats?: RunOutcome["gateSignals"]["valueStats"];
  /* Whether the failure is in the change's reach; absent when no case failed. */
  causal?: RunOutcome["gateSignals"]["causal"];
}

/** What the end of a run adds to the error class of its verdict. */
export interface ErrorClassEnds {
  generationEnd?: GenerationEndKind | undefined;
  preconditionFailed?: boolean | undefined;
  reviewerUnavailable?: boolean | undefined;
  reviewDisputed?: boolean | undefined;
  /** The launcher refused to start agent code in this run: whatever path took it to an infra-error, that is the reason. */
  sandboxRefused?: boolean | undefined;
}

/*
 * Shared errorClass derivation. Callers that never reach review omit
 * reviewerCorrections and get [].
 */
export function deriveErrorClass(
  verdict: string,
  coverageRatio: number | null,
  valueScore: number | null,
  reviewerCorrections: string[] = [],
  ends: ErrorClassEnds = {},
): string | null {
  /* Whatever path took the run to its infra-error, a launcher that refused to start agent code in it is the reason. */
  const sandboxUnavailable = verdict === "infra-error" && ends.sandboxRefused === true;
  return resolveErrorClass({
    verdict,
    coverageRatio,
    minCoverageRatio: DEFAULT_MIN_COVERAGE_RATIO,
    reviewerCorrections,
    valueScore,
    ...(ends.generationEnd ? { generationEnd: ends.generationEnd } : {}),
    ...(ends.preconditionFailed ? { preconditionFailed: true } : {}),
    ...(ends.reviewerUnavailable ? { reviewerUnavailable: true } : {}),
    ...(ends.reviewDisputed ? { reviewDisputed: true } : {}),
    ...(sandboxUnavailable ? { sandboxUnavailable: true } : {}),
  });
}

/*
 * Narrow ReflectionInput from an already-persisted RunOutcome only — no repo
 * reads. logs/note are unreachable here so a reflection prompt cannot leak them.
 * archetype is computed by the caller (outcome carries no diff).
 */
export function toReflectionInput(outcome: RunOutcome, archetype: string | null): ReflectionInput {
  return {
    runId: outcome.runId,
    app: outcome.app,
    sha: outcome.sha,
    mode: outcome.mode,
    verdict: outcome.verdict,
    /*
     * errorClass is string | null on the outcome. Coalesce to "" defensively; the
     * reflect gate already requires a non-null non-empty class before this is called.
     */
    errorClass: outcome.errorClass ?? "",
    gateSignals: {
      static: outcome.gateSignals.static,
      coverageRatio: outcome.gateSignals.coverageRatio,
      valueScore: outcome.gateSignals.valueScore,
      reviewerCorrections: outcome.gateSignals.reviewerCorrections,
      flaky: outcome.gateSignals.flaky,
      retries: outcome.gateSignals.retries,
    },
    archetype,
  };
}

/** The outcome the run persists for a decision, bound to this run's input. */
export function toRunOutcome(
  ctx: Pick<RunContext, "input" | "deps" | "host">,
  decision: RunDecision,
  cases: QaCase[],
  retries: number,
  coverageRatio: number | null,
  errorClass: string | null,
  extra?: OutcomeExtras,
): RunOutcome {
  const { input, deps } = ctx;
  const coordination = ctx.host.coordination();
  const sandbox = ctx.host.sandboxSignal();
  const gateCoverageRatio = coverageRatio;
  const gateValueScore = extra?.valueScore ?? null;
  return {
    runId: input.runId,
    app: input.app,
    sha: input.sha.toString(),
    mode: input.mode,
    target: input.target,
    verdict: decision.verdict,
    errorClass,
    gateSignals: {
      /* Default staticOk is false. Callers pass the real per-path value. */
      static: extra?.staticOk ?? false,
      coverageRatio: gateCoverageRatio,
      valueScore: gateValueScore,
      /* Conditional-spread, not `?? 0`: absent means the oracle never measured this run. */
      ...(extra?.mutantCount !== undefined ? { mutantCount: extra.mutantCount } : {}),
      ...(extra?.killedCount !== undefined ? { killedCount: extra.killedCount } : {}),
      ...(extra?.branchCoverage ? { branchCoverage: extra.branchCoverage } : {}),
      ...(extra?.changeCoverage ? { changeCoverage: extra.changeCoverage } : {}),
      ...(extra?.bundleMutation ? { bundleMutation: extra.bundleMutation } : {}),
      ...(extra?.branchCases ? { branchCases: extra.branchCases } : {}),
      ...(extra?.survivorClosure ? { survivorClosure: extra.survivorClosure } : {}),
      ...(extra?.flakyTriage ? { flakyTriage: extra.flakyTriage } : {}),
      ...(extra?.missingCases?.length ? { missingCases: extra.missingCases } : {}),
      reviewerCorrections: extra?.reviewerCorrections ?? [],
      /* Conditional-spread: true undefined survives when no reviewer-unavailable rationale exists. */
      ...(extra?.reviewerRationale !== undefined ? { reviewerRationale: extra.reviewerRationale } : {}),
      ...(extra?.reviewerApproved !== undefined ? { reviewerApproved: extra.reviewerApproved } : {}),
      ...(extra?.reviewer !== undefined ? { reviewer: extra.reviewer } : {}),
      flaky: decision.verdict === "flaky",
      retries,
      preExecAmbiguityCatches: extra?.preExecAmbiguityCatches ?? 0,
      deterministicSelectorBlocks: extra?.deterministicSelectorBlocks ?? 0,
      catalogGateInWindow: extra?.catalogGateInWindow ?? 0,
      catalogGateAdvisory: extra?.catalogGateAdvisory ?? 0,
      catalogGateFailClosed: extra?.catalogGateFailClosed ?? 0,
      /* What the sandbox did for this run; absent when no child was started or refused. */
      ...(sandbox ? { sandbox } : {}),
      ...(deps.config?.reviewerIndependence !== undefined ? { reviewerIndependence: deps.config.reviewerIndependence } : {}),
      /*
       * Conditional-spread, not `?? 0`: "never ran" stays distinguishable from
       * "ran and found zero".
       */
      ...(extra?.structuralSignalBytes !== undefined ? { structuralSignalBytes: extra.structuralSignalBytes } : {}),
      ...(extra?.serviceLinksCount !== undefined ? { serviceLinksCount: extra.serviceLinksCount } : {}),
      ...(extra?.contractDriftCount !== undefined ? { contractDriftCount: extra.contractDriftCount } : {}),
      ...(extra?.crossRepoImpactedCount !== undefined ? { crossRepoImpactedCount: extra.crossRepoImpactedCount } : {}),
      ...(extra?.confinement !== undefined ? { confinement: extra.confinement } : {}),
      ...(extra?.closedLoop !== undefined ? { closedLoop: extra.closedLoop } : {}),
      ...(extra?.agentBrowser !== undefined ? { agentBrowser: extra.agentBrowser } : {}),
      ...(extra?.coverage !== undefined ? { coverage: extra.coverage } : {}),
      ...(extra?.value !== undefined ? { value: extra.value } : {}),
      ...(extra?.integrity !== undefined ? { integrity: extra.integrity } : {}),
      ...(extra?.intent !== undefined ? { intent: extra.intent } : {}),
      ...(extra?.noop !== undefined ? { noop: extra.noop } : {}),
      ...(extra?.causal !== undefined ? { causal: extra.causal } : {}),
      ...(extra?.coverageByCandidate !== undefined ? { coverageByCandidate: extra.coverageByCandidate } : {}),
      ...(extra?.valueByCandidate !== undefined ? { valueByCandidate: extra.valueByCandidate } : {}),
      ...(extra?.valueStats !== undefined ? { valueStats: extra.valueStats } : {}),
      ...(coordination ? { coordination } : {}),
    },
    rulesRetrieved: extra?.rulesRetrieved ?? [],
    ...(extra?.diffArchetypes !== undefined ? { diffArchetypes: extra.diffArchetypes } : {}),
    ...(input.purpose !== undefined || extra?.note !== undefined ? { note: [input.purpose !== undefined ? `[${input.purpose}]` : undefined, extra?.note].filter((part) => part !== undefined).join(" ") } : {}),
    at: new Date().toISOString(),
    /* Persist the same cases + logs the returned result carries. Non-execute callers pass []. */
    cases,
    ...(extra?.logs !== undefined ? { logs: extra.logs } : {}),
    /* Conditional-spread — only when FixLoop genuinely produced a verdict class. */
    ...(extra?.adjudicationClass !== undefined ? { adjudication: { class: extra.adjudicationClass } } : {}),
  };
}
