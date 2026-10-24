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
import { CORRECTION_ORIGIN, type CorrectionOrigin, type ReviewerFinding } from "../../coordination/lead-correction.ts";
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
}

/* One regeneration by the lead alone over what the run has delivered so far; what it delivers joins that. */
export async function regenerateByLead(state: Readonly<RunState>, ctx: WorkspaceRunContext, regenerationSignal: AbortSignal | undefined, enrichment: GenerationEnrichment): Promise<GenerationOutput> {
  const { deps, workspace, generation } = ctx;
  const regenerated = await afterGeneration(ctx, await deps.generation.generate([], workspace.specDir, regenerationSignal, state.classification.diff, {
    ...state.grounding.baseEnrichment,
    ...geolocationEnrichment(ctx),
    ...enrichment,
    ...(generation.delivered.length > 0 ? { deliveredSpecs: generation.delivered } : {}),
  }));
  generation.delivered = mergeDeliveredSpecs(generation.delivered, regenerated, "lead");
  return regenerated;
}

/* The most of one failure's detail a finding carries; the sidekick reruns its spec for the rest. */
const MAX_FINDING_DETAIL_CHARS = 2_000;
const cutDetail = (text: string): string => (text.length > MAX_FINDING_DETAIL_CHARS ? `${text.slice(0, MAX_FINDING_DETAIL_CHARS)} … (cut)` : text);

/* What the static gate reported is one error block per file it refused: each is a finding of its own, so each reaches the flow it names. */
const STATIC_GATE_CASE = "static-gate";

type Correctable = "fixCases" | "selectorContradictions" | "coverageGap" | "contractFeedback";

/* One finding a regeneration's evidence yields, and the piece of that evidence it stands for. */
interface EvidenceFinding {
  finding: ReviewerFinding;
  from: Correctable;
  index: number;
}

/* The findings a regeneration's evidence names, one per failing case, error block, contradiction, uncovered gap and contract delta. */
function findingsOf(enrichment: GenerationEnrichment): EvidenceFinding[] {
  const out: EvidenceFinding[] = [];
  (enrichment.fixCases ?? []).forEach((c, index) => {
    if (c.name === STATIC_GATE_CASE && !c.file) {
      for (const block of (c.detail ?? "").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)) {
        out.push({ finding: { text: `the static gate refused the spec: ${cutDetail(block)}` }, from: "fixCases", index });
      }
      return;
    }
    const text = `test "${c.name}"${c.file ? ` in ${c.file}` : ""} ${c.status === "flaky" ? "passed only on retry" : "failed"}${c.detail ? `: ${cutDetail(c.detail)}` : ""}`;
    out.push({ finding: { text, ...(c.file ? { spec: c.file } : {}) }, from: "fixCases", index });
  });
  const attributed = enrichment.attributedSpecFiles ?? [];
  (enrichment.selectorContradictions ?? []).forEach((text, index) => {
    out.push({ finding: { text, ...(attributed.length === 1 ? { spec: attributed[0]! } : {}) }, from: "selectorContradictions", index });
  });
  if (enrichment.coverageGap) out.push({ finding: { text: enrichment.coverageGap }, from: "coverageGap", index: 0 });
  (enrichment.contractFeedback ?? []).forEach((v, index) => {
    out.push({ finding: { text: contractFindingText(v), spec: v.file }, from: "contractFeedback", index });
  });
  return out;
}

/* A contract delta the intent lock found, as a finding: the clause, what it held before and what it holds now. */
export function contractFindingText(v: { rule: string; file: string; clauseId: string; before: string; after: string }): string {
  return `the correction broke the test's contract (${v.rule}) in ${v.file}, clause ${v.clauseId}: it was ${JSON.stringify(v.before)} and is ${JSON.stringify(v.after)}`;
}

/* The evidence no flow took, as the lead's regeneration reads it: the rest of the enrichment kept, each correctable piece cut to what is left of it. */
function leftoverOf(enrichment: GenerationEnrichment, findings: readonly EvidenceFinding[], unrouted: readonly string[]): GenerationEnrichment {
  const left = new Set(unrouted);
  const keeps = (from: Correctable, index: number): boolean => findings.some((f) => f.from === from && f.index === index && left.has(f.finding.text));
  const { fixCases, selectorContradictions, coverageGap, contractFeedback, domSnapshot, attributedSpecFiles, ...rest } = enrichment;
  const cases = (fixCases ?? []).filter((_, i) => keeps("fixCases", i));
  const contradictions = (selectorContradictions ?? []).filter((_, i) => keeps("selectorContradictions", i));
  const deltas = (contractFeedback ?? []).filter((_, i) => keeps("contractFeedback", i));
  return {
    ...rest,
    ...(cases.length > 0 ? { fixCases: cases, ...(domSnapshot ? { domSnapshot } : {}) } : {}),
    ...(contradictions.length > 0 ? { selectorContradictions: contradictions, ...(attributedSpecFiles ? { attributedSpecFiles } : {}) } : {}),
    ...(coverageGap && keeps("coverageGap", 0) ? { coverageGap } : {}),
    ...(deltas.length > 0 ? { contractFeedback: deltas } : {}),
  };
}

/*
 * One regeneration over what the run has delivered so far; what it delivers joins that. In a run whose flows were authored by
 * sidekicks and whose pass is still open, the evidence goes to the lead first, which routes each finding to the flow whose spec it
 * names, as the reviewer's corrections are; what no flow takes goes to the lead's own regeneration with only that evidence. A run
 * the lead authored alone, or evidence that names nothing to correct, regenerates as it always did.
 */
export async function regenerate(
  state: Readonly<RunState>,
  ctx: WorkspaceRunContext,
  regenerationSignal: AbortSignal | undefined,
  enrichment: GenerationEnrichment,
  origin: Exclude<CorrectionOrigin, typeof CORRECTION_ORIGIN.REVIEW>,
): Promise<GenerationOutput> {
  const pass = ctx.trail.coordinatedPass;
  const findings = pass ? findingsOf(enrichment) : [];
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
  findings: readonly ReviewerFinding[],
  regenerationSignal: AbortSignal | undefined,
  origin: CorrectionOrigin = CORRECTION_ORIGIN.REVIEW,
  leftover: (unrouted: readonly string[]) => GenerationEnrichment = (unrouted) => ({ reviewCorrections: [...unrouted] }),
): Promise<GenerationOutput> {
  const corrected = await pass.correct(findings, origin);
  /* Recorded after every turn, so however the run ends from here what the lead routed is on its record. */
  ctx.ends.recordCorrections();
  const byFlows = await afterGeneration(ctx, {
    specs: corrected.specs,
    end: corrected.specs.length > 0 ? GENERATION_END.DELIVERED : GENERATION_END.UNDECIDED_EMPTY,
    reviewed: false,
    approved: true,
    parsed: corrected.readable,
  } satisfies GenerationOutput);
  ctx.generation.delivered = mergeDeliveredSpecs(ctx.generation.delivered, byFlows, "sidekick");
  const regenerated = corrected.unrouted.length > 0 ? await regenerateByLead(state, ctx, regenerationSignal, leftover(corrected.unrouted)) : undefined;
  const rebuttals = [...corrected.rebuttals, ...(regenerated?.rebuttals ?? [])];
  const specs = [...new Set([...byFlows.specs, ...(regenerated?.specs ?? [])])];
  return { ...(regenerated ?? byFlows), specs, end: specs.length > 0 ? GENERATION_END.DELIVERED : (regenerated?.end ?? byFlows.end), ...(rebuttals.length > 0 ? { rebuttals } : {}) };
}
