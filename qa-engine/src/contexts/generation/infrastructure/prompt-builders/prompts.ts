/* Assembles the per-run TASK + CONTEXT the agent receives, and the independent reviewer's prompt. The "how" lives in agents/agent/*.md. A prompt is a registry of sections (generator-sections.ts, reviewer-sections.ts) filtered and rendered from one derived context. Diffs are capped then secret-scrubbed; never import src/. */

import { suiteListingHead } from "@contexts/generation/domain/suite-listing-render.ts";
import { AGENT_BROWSER_SECTION_ID, CLOSED_LOOP_SECTION_ID, GEOLOCATION_SECTION_ID, HARNESS_FACTS_SECTION_ID, LEAD_PLAN_SECTION_ID } from "@contexts/generation/domain/prompt-contract-lint.ts";
import { PROMPT_HEADINGS, ASSEMBLED_ARTIFACT_NAMES } from "@contexts/generation/domain/prompt-headings.ts";
import type { ReviewInput } from "../../domain/generation-input.ts";
import type { OpencodeRunInput } from "../../domain/opencode-run-input.ts";
import { assemble, type AssembledPrompt } from "./context-assembler.ts";
import { derivePromptContext, withAssembly, type Assembly, type BuildPromptAssembledOpts, type PromptContext, type PromptFit } from "./generator-context.ts";
import { GENERATOR_SECTIONS, SUITE_LISTING_SECTION_ID } from "./generator-sections.ts";
import { engineLog } from "@kernel/ports/process-logger.ts";
import { renderSections } from "./prompt-sections.ts";
import { reviewsByFlow } from "./review-render.ts";
import { degradationOrder } from "./reviewer-change-sections.ts";
import { REVIEWER_MISSING_CASES_SECTION_ID, REVIEWER_SECTIONS, deriveReviewerContext, type BuildReviewerPromptOpts } from "./reviewer-sections.ts";

export type { AssembledPrompt };
export { PROMPT_HEADINGS, ASSEMBLED_ARTIFACT_NAMES };
export { REVIEWER_MISSING_CASES_SECTION_ID };
export { AGENT_BROWSER_SECTION_ID, CLOSED_LOOP_SECTION_ID, GEOLOCATION_SECTION_ID, LEAD_PLAN_SECTION_ID };

export function specFileForFlow(flow: string): string {
  const safe = flow.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "flow";
  return `flows/${safe}.spec.ts`;
}

/* The files whose content the surviving sections render compactly: reading one of them re-fetches what the prompt already carries. A section that was shed contributes nothing. */
function providedPathsOf(input: OpencodeRunInput, sectionSizes: Record<string, number>): string[] {
  const paths: string[] = [];
  if (sectionSizes["arch-map"] !== undefined) paths.push(`${input.e2eRelDir}/.qa/context.json`);
  if (sectionSizes[HARNESS_FACTS_SECTION_ID] !== undefined && input.harnessFacts?.fixtures) {
    paths.push(`${input.e2eRelDir}/${input.harnessFacts.fixtures.file}`);
  }
  if (sectionSizes[HARNESS_FACTS_SECTION_ID] !== undefined && input.harnessFacts?.playwright) paths.push(`${input.e2eRelDir}/playwright.config.ts`);
  if (sectionSizes["static-signal"] !== undefined) paths.push(...(input.staticSignalFiles ?? []));
  return paths;
}

/* A generator prompt and the role it is for: the lead on a planning turn, the author on any other. */
export type GeneratorPrompt = AssembledPrompt & { promptRole: "lead" | "author" };

/*
 * How many ranked pieces of the planning diff the lead's prompt shows: the longest prefix of the ranking whose prompt the fit rule
 * does not call over the lead's window and the assembler's budget does not cut; every other piece is named as a reference. The
 * prompt with no piece shown (the change map and every reference) is assembled once and the size of any other count follows
 * from the section's own size, so nothing is assembled per piece. A prompt over the window even with no piece shown is sent in
 * that minimal form, and its fit records it. An unknown fit and no budget hold nothing back.
 */
function fittedPlanDiffShown(ctx: PromptContext, fit: PromptFit | undefined): number {
  const section = ctx.planDiff;
  if (!section) return 0;
  /* The assembler reads a budget of 0 as none. */
  const budget = ctx.budgetBytes !== undefined && ctx.budgetBytes > 0 ? ctx.budgetBytes : undefined;
  const outcome = (bytes: number): ReturnType<PromptFit> => fit?.({ bytes, role: ctx.promptRole }) ?? "unknown";
  const allowed = (bytes: number): boolean => (budget === undefined || bytes <= budget) && outcome(bytes) !== "over";
  if (budget === undefined && fit === undefined) return section.pieces;
  const minimal = assemble(renderSections(GENERATOR_SECTIONS, { ...ctx, planDiffShown: 0 }), { budgetBytes: budget });
  if ((minimal.droppedSections?.length ?? 0) > 0 || Object.values(minimal.sectionItems).some((item) => item.capped)) return 0;
  const rest = Buffer.byteLength(minimal.text, "utf8") - section.bytes(0);
  let shown = 0;
  while (shown < section.pieces && allowed(rest + section.bytes(shown + 1))) shown++;
  return shown;
}

export function buildPromptAssembled(input: OpencodeRunInput, opts: BuildPromptAssembledOpts = {}): GeneratorPrompt {
  const derived = derivePromptContext(input, opts);
  const ctx: PromptContext = derived.planDiff ? { ...derived, planDiffShown: fittedPlanDiffShown(derived, opts.fit) } : derived;
  const assembleWith = (assembly: Assembly): AssembledPrompt =>
    assemble(renderSections(GENERATOR_SECTIONS, withAssembly(ctx, assembly)), { budgetBytes: ctx.budgetBytes });

  /* The listing is a section the byte budget may cut or shed. What the task says about reading the suite depends on whether the listing is there, and the decision not to ask for the outcome again rests on the objectives the listing shows. So when the budget sheds the listing the prompt is assembled again with the task worded for a prompt that has none, so that the agent is sent to read the suite and no claim reads a fact the prompt provides; when it cuts the listing, the prompt is assembled again with what is left of it. Either way the task asks for the outcome. The second assembly is kept only if the question costs the prompt no section and no part of the head of the listing: a wording must not take what the listing is for. */
  let assembled = assembleWith(ctx.assembly);
  const kept = assembled.sectionSizes[SUITE_LISTING_SECTION_ID];
  if (ctx.suiteIsListed && kept !== Buffer.byteLength(ctx.listingContent, "utf8")) {
    const reassembled = assembleWith({ suiteListed: kept !== undefined, reaskObjective: true });
    const keepsEverySection = Object.keys(assembled.sectionSizes).every((id) => reassembled.sectionSizes[id] !== undefined);
    if (keepsEverySection && (kept === undefined || reassembled.text.includes(suiteListingHead(ctx.listing)))) assembled = reassembled;
  }
  return { ...assembled, providedPaths: providedPathsOf(input, assembled.sectionSizes), promptRole: ctx.promptRole };
}

export function buildPrompt(input: OpencodeRunInput): string {
  return buildPromptAssembled(input).text;
}

/*
 * A planned run's reviewer prompt that does not fit the reviewer's window (the prompt plus the working room its turn needs) shows
 * parts of the change as references, in degradationOrder, until it fits; an unknown fit shows everything. The review is never split:
 * a prompt still over the window with every part referenced is sent as it is, and the fit it records says so.
 */
export function buildReviewerPromptAssembled(input: ReviewInput, opts: BuildReviewerPromptOpts = {}): AssembledPrompt {
  const ctx = deriveReviewerContext(input, opts);
  const assembleWith = (degraded: ReadonlySet<string>): AssembledPrompt => assemble(renderSections(REVIEWER_SECTIONS, { ...ctx, degraded }), { budgetBytes: ctx.budgetBytes });
  let assembled = assembleWith(ctx.degraded);
  const fit = opts.fit;
  if (!fit || !reviewsByFlow(input)) return assembled;
  const over = (bytes: number): boolean => fit({ bytes, role: "reviewer" }) === "over";
  if (!over(Buffer.byteLength(assembled.text, "utf8"))) return assembled;
  const order = degradationOrder(input.changeView);
  const degraded = new Set<string>();
  let next = 0;
  while (next < order.length) {
    /* Estimated from each part's saving, then checked against the assembled prompt. */
    let estimate = Buffer.byteLength(assembled.text, "utf8");
    while (next < order.length && over(estimate)) {
      const item = order[next++]!;
      degraded.add(item.key);
      estimate -= item.savingBytes;
    }
    assembled = assembleWith(degraded);
    if (!over(Buffer.byteLength(assembled.text, "utf8"))) return assembled;
  }
  engineLog.warn(`[qa] the reviewer prompt is over the reviewer's window with every part of the change shown as a reference; it is sent whole, never split.`);
  return assembled;
}

export function buildReviewerPrompt(input: ReviewInput): string {
  return buildReviewerPromptAssembled(input).text;
}
