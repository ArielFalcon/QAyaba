/* Assembles the per-run TASK + CONTEXT the agent receives, and the independent reviewer's prompt. The "how" lives in agents/agent/*.md. A prompt is a registry of sections (generator-sections.ts, reviewer-sections.ts) filtered and rendered from one derived context. Diffs are capped then secret-scrubbed; never import src/. */

import { suiteListingHead } from "@contexts/generation/domain/suite-listing-render.ts";
import { AGENT_BROWSER_SECTION_ID, CLOSED_LOOP_SECTION_ID, GEOLOCATION_SECTION_ID, HARNESS_FACTS_SECTION_ID, LEAD_PLAN_SECTION_ID } from "@contexts/generation/domain/prompt-contract-lint.ts";
import { PROMPT_HEADINGS, ASSEMBLED_ARTIFACT_NAMES } from "@contexts/generation/domain/prompt-headings.ts";
import type { ReviewInput } from "../../domain/generation-input.ts";
import type { OpencodeRunInput } from "../../domain/opencode-run-input.ts";
import { assemble, type AssembledPrompt } from "./context-assembler.ts";
import { derivePromptContext, withAssembly, type Assembly, type BuildPromptAssembledOpts } from "./generator-context.ts";
import { GENERATOR_SECTIONS, SUITE_LISTING_SECTION_ID } from "./generator-sections.ts";
import { renderSections } from "./prompt-sections.ts";
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

export function buildPromptAssembled(input: OpencodeRunInput, opts: BuildPromptAssembledOpts = {}): GeneratorPrompt {
  const ctx = derivePromptContext(input, opts);
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

export function buildReviewerPromptAssembled(input: ReviewInput, opts: BuildReviewerPromptOpts = {}): AssembledPrompt {
  const ctx = deriveReviewerContext(input, opts);
  return assemble(renderSections(REVIEWER_SECTIONS, ctx), { budgetBytes: ctx.budgetBytes });
}

export function buildReviewerPrompt(input: ReviewInput): string {
  return buildReviewerPromptAssembled(input).text;
}
