/*
 * What the generation of a run needs from more than one phase: the work that follows every generation by the lead, the question
 * of whether the run_spec loop has done the work a regeneration would repeat, and one regeneration over what the run has delivered.
 * They are behavior, so they are functions of the run's context and state; the specs delivered so far are the one mutable fact,
 * held on `state.generation` and changed only by the reducers.
 */

import { engineLog } from "@kernel/ports/process-logger.ts";
import { normalizeSpecPath } from "@kernel/spec-path.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import type { ClosedLoopGateSignal } from "@kernel/closed-loop.ts";
import type { GeolocationFacts } from "@kernel/geolocation.ts";
import { PROBE_REL_DIR } from "@contexts/test-execution/application/index.ts";
import type { GenerationEnrichment, GenerationOutput } from "@contexts/generation/application/index.ts";
import type { CoordinatedPass } from "@contexts/coordination/application/index.ts";
import { CORRECTION_ORIGIN, authorTargetOf, dispatchAuthor, type CorrectionOrigin, type CorrectionFinding } from "@contexts/coordination/application/index.ts";
import { FLAKY_CLASS, type FlakyCaseTriage } from "../../../domain/flaky-triage.ts";
import { leadCorrectionAction, leadCorrectionBudget } from "../../../domain/lead-correction-budget.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import type { RunState } from "../run-state.ts";
import { mergeDelivered } from "../reducers.ts";

/* A probe is a throwaway spec the generator ran through run_spec: it lives under the probe directory and is never a deliverable. */
function isProbeSpec(file: string): boolean {
  return normalizeSpecPath(file).split("/").includes(PROBE_REL_DIR);
}

/* The generation without the probes it listed as deliverables; the same object when it listed none. */
export function withoutProbeSpecs<T extends Pick<GenerationOutput, "specs" | "declaredSpecs">>(output: T): T {
  if (!output.specs.some(isProbeSpec) && !(output.declaredSpecs ?? []).some((d) => isProbeSpec(d.file))) return output;
  return {
    ...output,
    specs: output.specs.filter((file) => !isProbeSpec(file)),
    ...(output.declaredSpecs ? { declaredSpecs: output.declaredSpecs.filter((d) => !isProbeSpec(d.file)) } : {}),
  };
}

export { ProbeSweepError } from "../failure-policy.ts";
import { ProbeSweepError } from "../failure-policy.ts";

export const geolocationEnrichment = (ctx: WorkspaceRunContext): { geolocation?: GeolocationFacts } =>
  ctx.trail.geolocation ? { geolocation: ctx.trail.geolocation.facts() } : {};

/* What follows every generation by the lead: the probes it left behind are swept before anything looks at the working copy, and none is a deliverable. Without a loop, the generation is returned as it is. */
export async function afterGeneration<T extends Pick<GenerationOutput, "specs" | "declaredSpecs">>(ctx: WorkspaceRunContext, output: T): Promise<T> {
  const { closedLoop } = ctx.trail;
  if (!closedLoop) return output;
  try {
    await closedLoop.sweepProbes();
  } catch (err) {
    /* Fail closed: a working copy that may still hold throwaway specs is not validated, executed or published. The run ends as an infra-error (runInScope). */
    throw new ProbeSweepError(err instanceof Error ? err.message : String(err));
  }
  return withoutProbeSpecs(output);
}

/* Whether every delivered spec was seen passing in the bytes it has now: the generator has already done the work a regeneration would repeat. A fault in asking is "not closed", which keeps every regeneration. */
export async function loopClosedNow(state: Readonly<RunState>, ctx: WorkspaceRunContext): Promise<boolean> {
  const { closedLoop } = ctx.trail;
  const { delivered } = state.generation;
  if (!closedLoop || delivered.length === 0) return false;
  try {
    return await closedLoop.isClosed(delivered.map((d) => d.file));
  } catch (err) {
    engineLog.error(`[qa] could not tell whether the run_spec loop is closed (regenerations stay on): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function closedLoopSignal(state: Readonly<RunState>, ctx: WorkspaceRunContext): Promise<ClosedLoopGateSignal | undefined> {
  const { closedLoop } = ctx.trail;
  return closedLoop ? { ...closedLoop.signals(), closed: await loopClosedNow(state, ctx) } : undefined;
/* mutation-scope:begin author-regeneration-routing */
}

/* One regeneration by a fresh author sidekick over what the run has delivered so far; what it delivers joins that. */
export async function regenerateByAuthor(state: Readonly<RunState>, ctx: WorkspaceRunContext, regenerationSignal: AbortSignal | undefined, enrichment: GenerationEnrichment): Promise<GenerationOutput> {
  const { deps, workspace, cfg } = ctx;
  const regenerated = await afterGeneration(ctx, await dispatchAuthor(deps.generation, {
    target: authorTargetOf({ isCode: cfg.isCode, mode: ctx.input.mode }),
    specDir: workspace.specDir,
    ...(regenerationSignal ? { signal: regenerationSignal } : {}),
    diff: state.classification.diff,
    enrichment: {
      ...state.grounding.baseEnrichment,
      ...geolocationEnrichment(ctx),
      ...enrichment,
      ...(state.generation.delivered.length > 0 ? { deliveredSpecs: state.generation.delivered } : {}),
/* mutation-scope:end author-regeneration-routing */
    },
  }));
  mergeDelivered(state, regenerated, "author");
  return regenerated;
}

/* The most of one failure's detail a finding carries; the sidekick reruns its spec for the rest. */
const MAX_FINDING_DETAIL_CHARS = 2_000;
const cutDetail = (text: string): string => (text.length > MAX_FINDING_DETAIL_CHARS ? `${text.slice(0, MAX_FINDING_DETAIL_CHARS)} … (cut)` : text);

/* One finding a regeneration's evidence yields. */
export interface EvidenceFinding {
  finding: CorrectionFinding;
}

/* A contract delta the intent lock found, as a finding: the clause, what it held before and what it holds now. */
export function contractFindingText(v: { rule: string; file: string; clauseId: string; before: string; after: string }): string {
  return `the correction broke the test's contract (${v.rule}) in ${v.file}, clause ${v.clauseId}: it was ${JSON.stringify(v.before)} and is ${JSON.stringify(v.after)}`;
}

/* The static gate's errors, one finding each, as the gate reported them: each names the file it refused. */
export function staticGateFindings(errors: readonly string[]): EvidenceFinding[] {
  return errors.map((error) => error.trim()).filter(Boolean).map((error) => ({
    finding: { text: `the static gate refused the spec: ${cutDetail(error)}` },
  }));
}

/*
 * The flaky cases of a green run, one finding each, naming the spec that holds the case so the lead routes it to its flow: the
 * first attempt failed and the same bytes passed on retry, which is no state to publish from. What the flow is told to change
 * follows the class: a spec that read DEV's data differently between attempts stops depending on it, any other waits on what the
 * page shows.
 */
export function flakyFindings(triage: readonly FlakyCaseTriage[]): EvidenceFinding[] {
  return triage.map(({ case: c, class: flakyClass, evidence }) => {
    const subject = `test "${c.name}"${c.file ? ` in ${c.file}` : ""} failed its first attempt and passed on retry; ${evidence}`;
    const detail = c.detail ? ` (${cutDetail(c.detail)})` : "";
    const remedy = flakyClass === FLAKY_CLASS.DATA_INSTABILITY
      ? "DEV's data changed between attempts, so the spec depends on live data. Stop depending on it: derive every expected value from what the page shows when the test runs, or pin the state the app lets a test pin."
      : "the page was not in the state the assertion waited for. Wait on the state the page shows (a web-first assertion on the settled result), never on a fixed delay.";
    return { finding: { text: `${subject}${detail}: ${remedy}`, ...(c.file ? { spec: c.file } : {}) } };
  });
}

/* The findings a regeneration's evidence names: one per failing case, contradiction and contract delta, and one per unit of the uncovered gap. */
function findingsOf(enrichment: GenerationEnrichment): EvidenceFinding[] {
  const out: EvidenceFinding[] = [];
  for (const c of enrichment.fixCases ?? []) {
    const text = `test "${c.name}"${c.file ? ` in ${c.file}` : ""} ${c.status === "flaky" ? "passed only on retry" : "failed"}${c.detail ? `: ${cutDetail(c.detail)}` : ""}`;
    out.push({ finding: { text, ...(c.file ? { spec: c.file } : {}) } });
  }
  const attributed = enrichment.attributedSpecFiles ?? [];
  for (const text of enrichment.selectorContradictions ?? []) {
    out.push({ finding: { text, ...(attributed.length === 1 ? { spec: attributed[0]! } : {}) } });
  }
  /* The gap is one finding per unit it lists, so a number the lead cites is one item; a gap with no units stays one finding. */
  const gapItems = enrichment.coverageGapItems ?? [];
  if (gapItems.length > 0) for (const text of gapItems) out.push({ finding: { text } });
  else if (enrichment.coverageGap) out.push({ finding: { text: enrichment.coverageGap } });
  for (const v of enrichment.contractFeedback ?? []) {
    out.push({ finding: { text: contractFindingText(v), spec: v.file } });
  }
  return out;
}

/* A regeneration's generation and the corrections it routed through the lead's pass (0 or 1): the step adds them to `loops.leadCorrections`. */
export interface Regenerated {
  output: GenerationOutput;
  leadCorrections: number;
}

/* Whether the run's budget of corrections through the lead has room for one more. */
export function mayCorrectThroughLead(state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean {
  return leadCorrectionAction({ used: state.loops.leadCorrections, budget: leadCorrectionBudget({ maxRetries: ctx.cfg.maxRetries }) }) === "through-lead";
}

/*
 * One regeneration over what the run has delivered so far; what it delivers joins that. In a run whose flows were authored by
 * sidekicks and whose pass is still open, the evidence goes to the lead first, which routes each finding to a flow (the one whose
 * spec it names, or any it names for a finding that cites none), as the reviewer's corrections are; what no flow takes stays
 * unrouted and is recorded, never handed to a cold author. The findings are read from the enrichment unless the caller names them
 * (the static gate's errors, which the lead alone reads as one case). When the run's budget of corrections through the lead is spent
 * the findings are recorded unrouted and nothing regenerates. A run the lead authored alone, or evidence that names nothing to
 * correct, regenerates as it always did.
 */
export async function regenerate(
  state: Readonly<RunState>,
  ctx: WorkspaceRunContext,
  regenerationSignal: AbortSignal | undefined,
  enrichment: GenerationEnrichment,
  origin: Exclude<CorrectionOrigin, typeof CORRECTION_ORIGIN.REVIEW>,
  evidence?: readonly EvidenceFinding[],
): Promise<Regenerated> {
  const pass = ctx.trail.coordinatedPass;
  const findings = pass ? (evidence ?? findingsOf(enrichment)) : [];
  if (!pass || findings.length === 0) return { output: await regenerateByAuthor(state, ctx, regenerationSignal, enrichment), leadCorrections: 0 };
  if (!mayCorrectThroughLead(state, ctx)) return correctionBudgetSpent(ctx, pass, findings.map((f) => f.finding), origin);
  return correctThroughLead(state, ctx, pass, findings.map((f) => f.finding), origin);
}

/* The reason recorded for findings a coordinated run no longer sends through the lead. */
export const LEAD_CORRECTION_BUDGET_SPENT = "lead correction budget spent";

/*
 * The run's budget of corrections through the lead is spent: the findings are recorded unrouted and nothing is regenerated, because
 * the only other author is a cold one with no flow, no run_spec history and no instruction of the lead's. What the flows delivered
 * stays as it is and the caller's acceptance goes on with it.
 */
export function correctionBudgetSpent(ctx: WorkspaceRunContext, pass: CoordinatedPass, findings: readonly CorrectionFinding[], origin: CorrectionOrigin): Regenerated {
  pass.leaveUnrouted(findings, origin, LEAD_CORRECTION_BUDGET_SPENT);
  ctx.host.recordCorrections();
  return { leadCorrections: 0, output: { specs: [], end: GENERATION_END.UNDECIDED_EMPTY, parsed: true } };
}

/*
 * Findings of one origin in a coordinated run: the lead routes them to the sidekicks of its flows, which correct their specs in
 * their own sessions. A finding that names a spec no flow owns gets one maintenance flow of the pass; what is left is recorded unrouted
 * by the pass and is not regenerated: a fresh author with no flow spec, no run_spec history and no instruction of the lead's is the
 * cold start this route replaces. What the flows deliver joins the run's delivery and goes through the caller's acceptance like any
 * regeneration.
 */
export async function correctThroughLead(
  state: Readonly<RunState>,
  ctx: WorkspaceRunContext,
  pass: CoordinatedPass,
  findings: readonly CorrectionFinding[],
  origin: CorrectionOrigin = CORRECTION_ORIGIN.REVIEW,
): Promise<Regenerated> {
  const corrected = await pass.correct(findings, origin);
  /* Recorded after every turn, so however the run ends from here what the lead routed is on its record. */
  ctx.host.recordCorrections();
  const byFlows = await afterGeneration<GenerationOutput>(ctx, {
    specs: corrected.specs,
    ...(corrected.specSources ? { specSources: corrected.specSources } : {}),
    end: corrected.specs.length > 0 ? GENERATION_END.DELIVERED : GENERATION_END.UNDECIDED_EMPTY,
    parsed: corrected.readable,
  });
  mergeDelivered(state, byFlows, "sidekick");
  const { testCorrect: _claim, specSources: _sources, ...base } = byFlows;
  const testCorrect = corrected.specs.length === 0 ? corrected.testCorrect : undefined;
  return {
    leadCorrections: 1,
    output: {
      ...base,
      specs: byFlows.specs,
      ...(byFlows.specSources ? { specSources: byFlows.specSources } : {}),
      ...(testCorrect ? { testCorrect } : {}),
      ...(corrected.rebuttals.length > 0 ? { rebuttals: corrected.rebuttals } : {}),
    },
  };
}
