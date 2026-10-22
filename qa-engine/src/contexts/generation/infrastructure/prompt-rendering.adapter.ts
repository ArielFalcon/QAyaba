import type { RenderedPromptFacts } from "../domain/prompt-facts.ts";
import type { PromptRenderingPort } from "../application/ports/index.ts";
import type { OpencodeRunInput, ReviewInput } from "../application/ports/generation-ports.ts";

export interface PromptBuilders {
  buildPromptAssembled(input: OpencodeRunInput): { text: string; sectionSizes: Record<string, number>; providedPaths?: readonly string[] } & RenderedPromptFacts;
  buildReviewerPromptAssembled(input: ReviewInput): { text: string; sectionSizes: Record<string, number> } & RenderedPromptFacts;
  buildExplorerPrompt(input: OpencodeRunInput): string;
  specFileForFlow(flow: string): string;
}

export class PromptRenderingAdapter implements PromptRenderingPort {
  constructor(private readonly b: PromptBuilders) {}

  renderMain(input: OpencodeRunInput): { text: string; sectionSizes: Record<string, number>; providedPaths?: readonly string[] } & RenderedPromptFacts {
    return this.b.buildPromptAssembled(input);
  }

  renderReviewer(input: ReviewInput): { text: string; sectionSizes: Record<string, number> } & RenderedPromptFacts {
    return this.b.buildReviewerPromptAssembled(input);
  }

  renderExplorer(input: OpencodeRunInput): string {
    return this.b.buildExplorerPrompt(input);
  }

  specFileForFlow(flow: string): string {
    return this.b.specFileForFlow(flow);
  }

  render(sections: readonly { heading: string; body: string }[]): string {
    return sections.map((s) => `# ${s.heading}\n\n${s.body}`).join("\n\n");
  }
}
