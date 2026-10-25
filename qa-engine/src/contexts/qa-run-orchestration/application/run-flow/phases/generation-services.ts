/*
 * What the generation of a run needs from more than one phase: the work that follows every generation by the lead, the question
 * of whether the run_spec loop has done the work a regeneration would repeat, and one regeneration over what the run has delivered.
 * They are behavior, so they are functions of the run's context and state; the specs delivered so far are the one mutable fact,
 * held on `ctx.generation`.
 */

import { normalizeSpecPath } from "@kernel/spec-path.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import type { ClosedLoopGateSignal } from "@kernel/closed-loop.ts";
import type { GeolocationFacts } from "@kernel/geolocation.ts";
import { PROBE_REL_DIR } from "@contexts/test-execution/domain/run-spec-capability.ts";
import { mergeDeliveredSpecs } from "../../../domain/helpers/delivered-specs.ts";
import type { GenerationEnrichment, GenerationOutput } from "../../ports/index.ts";
import type { CoordinatedPass } from "../../coordination/lead-sidekicks.ts";
import { CORRECTION_ORIGIN, type CorrectionOrigin, type CorrectionFinding } from "../../coordination/lead-correction.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import type { RunState } from "../run-state.ts";

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

/* The probes the generator left in the working copy could not be removed. */
export class ProbeSweepError extends Error {
  constructor(reason: string) {
    super(`the run_spec probes could not be removed from the working copy (${reason})`);
    this.name = "ProbeSweepError";
  }
}

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
export async function loopClosedNow(ctx: WorkspaceRunContext): Promise<boolean> {
  const { closedLoop } = ctx.trail;
  const { delivered } = ctx.generation;
  if (!closedLoop || delivered.length === 0) return false;
  try {
    return await closedLoop.isClosed(delivered.map((d) => d.file));
  } catch (err) {
    console.error(`[qa] could not tell whether the run_spec loop is closed (regenerations stay on): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function closedLoopSignal(ctx: WorkspaceRunContext): Promise<ClosedLoopGateSignal | undefined> {
  const { closedLoop } = ctx.trail;
  return closedLoop ? { ...closedLoop.signals(), closed: await loopClosedNow(ctx) } : undefined;
/* mutation-scope:begin lead-regeneration-routing */
}

/* One regeneration by the lead alone over what the run has delivered so far; what it delivers joins that. */
export async function regenerateByLead(state: Readonly<RunState>, ctx: WorkspaceRunContext, regenerationSignal: AbortSignal | undefined, enrichment: GenerationEnrichment): Promise<GenerationOutput> {
  const { deps, workspace, generation } = ctx;
  const regenerated = await afterGeneration(ctx, await deps.generation.generate([], workspace.specDir, regenerationSignal, state.classification.diff, {
    ...state.grounding.baseEnrichment,
    ...geolocationEnrichment(ctx),
    ...enrichment,
    ...(generation.delivered.length > 0 ? { deliveredSpecs: generation.delivered } : {}),
/* mutation-scope:end lead-regeneration-routing */
  }));
  generation.delivered = mergeDeliveredSpecs(generation.delivered, regenerated, "lead");
  return regenerated;
}

/* The most of one failure's detail a finding carries; the sidekick reruns its spec for the rest. */
const MAX_FINDING_DETAIL_CHARS = 2_000;
const cutDetail = (text: string): string => (text.length > MAX_FINDING_DETAIL_CHARS ? `${text.slice(0, MAX_FINDING_DETAIL_CHARS)} … (cut)` : text);

/* One finding a regeneration's evidence yields, and the slice of that evidence it stands for: what the lead regenerates with when no flow takes it. */
export interface EvidenceFinding {
  finding: CorrectionFinding;
  piece: Pick<GenerationEnrichment, "fixCases" | "selectorContradictions" | "coverageGap" | "contractFeedback">;
}

/* A contract delta the intent lock found, as a finding: the clause, what it held before and what it holds now. */
export function contractFindingText(v: { rule: string; file: string; clauseId: string; before: string; after: string }): string {
  return `the correction broke the test's contract (${v.rule}) in ${v.file}, clause ${v.clauseId}: it was ${JSON.stringify(v.before)} and is ${JSON.stringify(v.after)}`;
}

/* The static gate's errors, one finding each, as the gate reported them: each names the file it refused. */
export function staticGateFindings(errors: readonly string[]): EvidenceFinding[] {
  return errors.map((error) => error.trim()).filter(Boolean).map((error) => ({
    finding: { text: `the static gate refused the spec: ${cutDetail(error)}` },
    piece: { fixCases: [{ name: "static-gate", status: "fail", detail: cutDetail(error) }] },
  }));
}

/* The findings a regeneration's evidence names: one per failing case, contradiction and contract delta, and one for the uncovered gap. */
function findingsOf(enrichment: GenerationEnrichment): EvidenceFinding[] {
  const out: EvidenceFinding[] = [];
  for (const c of enrichment.fixCases ?? []) {
    const text = `test "${c.name}"${c.file ? ` in ${c.file}` : ""} ${c.status === "flaky" ? "passed only on retry" : "failed"}${c.detail ? `: ${cutDetail(c.detail)}` : ""}`;
    out.push({ finding: { text, ...(c.file ? { spec: c.file } : {}) }, piece: { fixCases: [c] } });
  }
  const attributed = enrichment.attributedSpecFiles ?? [];
  for (const text of enrichment.selectorContradictions ?? []) {
    out.push({ finding: { text, ...(attributed.length === 1 ? { spec: attributed[0]! } : {}) }, piece: { selectorContradictions: [text] } });
  }
  if (enrichment.coverageGap) out.push({ finding: { text: enrichment.coverageGap }, piece: { coverageGap: enrichment.coverageGap } });
  for (const v of enrichment.contractFeedback ?? []) {
    out.push({ finding: { text: contractFindingText(v), spec: v.file }, piece: { contractFeedback: [v] } });
  }
  return out;
}

/*
 * The evidence no flow took, as the lead's regeneration reads it: what the enrichment says beside the evidence, and the slices of
 * the findings left. The failure DOM goes with the failing cases it was captured for, the attribution with the contradictions.
 */
function leftoverOf(enrichment: GenerationEnrichment, findings: readonly EvidenceFinding[], unrouted: readonly number[]): GenerationEnrichment {
  const { fixCases: _cases, selectorContradictions: _contradictions, coverageGap: _gap, contractFeedback: _deltas, domSnapshot, attributedSpecFiles, ...rest } = enrichment;
  const pieces = unrouted.map((i) => findings[i]!.piece);
  const cases = pieces.flatMap((p) => p.fixCases ?? []);
  const contradictions = pieces.flatMap((p) => p.selectorContradictions ?? []);
  const deltas = pieces.flatMap((p) => p.contractFeedback ?? []);
  const gap = pieces.find((p) => p.coverageGap)?.coverageGap;
  return {
    ...rest,
    ...(cases.length > 0 ? { fixCases: cases, ...(domSnapshot ? { domSnapshot } : {}) } : {}),
    ...(contradictions.length > 0 ? { selectorContradictions: contradictions, ...(attributedSpecFiles ? { attributedSpecFiles } : {}) } : {}),
    ...(gap ? { coverageGap: gap } : {}),
    ...(deltas.length > 0 ? { contractFeedback: deltas } : {}),
  };
}

/*
 * One regeneration over what the run has delivered so far; what it delivers joins that. In a run whose flows were authored by
 * sidekicks and whose pass is still open, the evidence goes to the lead first, which routes each finding to the flow whose spec it
 * names, as the reviewer's corrections are; what no flow takes goes to the lead's own regeneration with only that evidence. The
 * findings are read from the enrichment unless the caller names them (the static gate's errors, which the lead alone reads as one
 * case). A run the lead authored alone, or evidence that names nothing to correct, regenerates as it always did.
 */
export async function regenerate(
  state: Readonly<RunState>,
  ctx: WorkspaceRunContext,
  regenerationSignal: AbortSignal | undefined,
  enrichment: GenerationEnrichment,
  origin: Exclude<CorrectionOrigin, typeof CORRECTION_ORIGIN.REVIEW>,
  evidence?: readonly EvidenceFinding[],
): Promise<GenerationOutput> {
  const pass = ctx.trail.coordinatedPass;
  const findings = pass ? (evidence ?? findingsOf(enrichment)) : [];
  if (!pass || findings.length === 0) return regenerateByLead(state, ctx, regenerationSignal, enrichment);
  return correctThroughLead(state, ctx, pass, findings.map((f) => f.finding), regenerationSignal, origin, (unrouted) => leftoverOf(enrichment, findings, unrouted));
}

/*
 * Findings of one origin in a coordinated run: the lead routes them to the sidekicks of its flows, which correct their specs in
 * their own sessions; what no flow was sent goes to a regeneration, as in a run the lead authored alone. What both deliver joins
 * the run's delivery and goes through the caller's acceptance like any regeneration. The reviewer's findings are the default, and
 * what no flow took of them is regenerated as the reviewer's corrections.
 */
export async function correctThroughLead(
  state: Readonly<RunState>,
  ctx: WorkspaceRunContext,
  pass: CoordinatedPass,
  findings: readonly CorrectionFinding[],
  regenerationSignal: AbortSignal | undefined,
  origin: CorrectionOrigin = CORRECTION_ORIGIN.REVIEW,
  leftover: (unrouted: readonly number[]) => GenerationEnrichment = (unrouted) => ({ reviewCorrections: unrouted.map((i) => findings[i]!.text) }),
): Promise<GenerationOutput> {
  const corrected = await pass.correct(findings, origin);
  /* Recorded after every turn, so however the run ends from here what the lead routed is on its record. */
  ctx.ends.recordCorrections();
  const byFlows = await afterGeneration<GenerationOutput>(ctx, {
    specs: corrected.specs,
    ...(corrected.specSources ? { specSources: corrected.specSources } : {}),
    end: corrected.specs.length > 0 ? GENERATION_END.DELIVERED : GENERATION_END.UNDECIDED_EMPTY,
    reviewed: false,
    approved: true,
    parsed: corrected.readable,
  });
  ctx.generation.delivered = mergeDeliveredSpecs(ctx.generation.delivered, byFlows, "sidekick");
  const regenerated = corrected.unrouted.length > 0 ? await regenerateByLead(state, ctx, regenerationSignal, leftover(corrected.unrouted)) : undefined;
  const rebuttals = [...corrected.rebuttals, ...(regenerated?.rebuttals ?? [])];
  const specs = [...new Set([...byFlows.specs, ...(regenerated?.specs ?? [])])];
  const specSources = sourcesOf(specs, [byFlows, ...(regenerated ? [regenerated] : [])]);
  /* A claim that the test is right stands only for a turn that changed no spec, the lead's regeneration included. */
  const testCorrect = specs.length === 0 ? (regenerated?.testCorrect ?? corrected.testCorrect) : undefined;
  const { testCorrect: _claim, specSources: _sources, ...base } = regenerated ?? byFlows;
  return {
    ...base,
    specs,
    end: specs.length > 0 ? GENERATION_END.DELIVERED : (regenerated?.end ?? byFlows.end),
    ...(specSources ? { specSources } : {}),
    ...(testCorrect ? { testCorrect } : {}),
    ...(rebuttals.length > 0 ? { rebuttals } : {}),
  };
}

/* The source of each spec, in order, from the generations that delivered them; absent when any one of them is unknown. */
function sourcesOf(specs: readonly string[], outputs: readonly Pick<GenerationOutput, "specs" | "specSources">[]): string[] | undefined {
  const known = new Map<string, string>();
  for (const output of outputs) output.specs.forEach((spec, i) => { const source = output.specSources?.[i]; if (source !== undefined) known.set(spec, source); });
  const sources = specs.map((spec) => known.get(spec));
  return sources.every((source) => source !== undefined) ? (sources as string[]) : undefined;
}
