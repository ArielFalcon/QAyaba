import type { OpencodeRunInput } from "../generation-input.ts";
import type { ReviewInput } from "../../domain/generation-input.ts";
import type { RenderedPromptFacts } from "../../domain/prompt-facts.ts";
import type { PromptSection } from "../../domain/manifest-repository.ts";

export interface PromptRenderingPort {
  render(sections: readonly PromptSection[]): string;
  /** `continuation`: the prompt of a regeneration sent in the session that already holds the run's grounding, so only what changed is rendered. */
  renderMain(input: OpencodeRunInput, opts?: { continuation?: boolean }): { text: string; sectionSizes: Record<string, number>; providedPaths?: readonly string[] } & RenderedPromptFacts;
  renderReviewer(input: ReviewInput): { text: string; sectionSizes: Record<string, number> } & RenderedPromptFacts;
  specFileForFlow(flow: string): string;
}
