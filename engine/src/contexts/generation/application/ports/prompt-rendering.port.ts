import type { OpencodeRunInput } from "../../domain/opencode-run-input.ts";
import type { ReviewInput } from "../../domain/generation-input.ts";
import type { RenderedPromptFacts } from "../../domain/prompt-facts.ts";
import type { PromptSection } from "../../domain/manifest-repository.ts";

export interface PromptRenderingPort {
  render(sections: readonly PromptSection[]): string;
  renderMain(input: OpencodeRunInput): { text: string; sectionSizes: Record<string, number>; providedPaths?: readonly string[] } & RenderedPromptFacts;
  renderReviewer(input: ReviewInput): { text: string; sectionSizes: Record<string, number> } & RenderedPromptFacts;
  specFileForFlow(flow: string): string;
}
