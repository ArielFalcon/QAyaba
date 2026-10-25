import type { RenderedPromptFacts } from "../domain/prompt-facts.ts";
import type { PromptRenderingPort } from "../application/ports/index.ts";
import type { OpencodeRunInput, ReviewInput } from "../application/ports/generation-ports.ts";

export interface PromptBuilders {
  buildPromptAssembled(input: OpencodeRunInput, opts?: { continuation?: boolean }): { text: string; sectionSizes: Record<string, number>; providedPaths?: readonly string[] } & RenderedPromptFacts;
  buildReviewerPromptAssembled(input: ReviewInput): { text: string; sectionSizes: Record<string, number> } & RenderedPromptFacts;
  specFileForFlow(flow: string): string;
}

export class PromptRenderingAdapter implements PromptRenderingPort {
  constructor(private readonly b: PromptBuilders) {}

  renderMain(input: OpencodeRunInput, opts?: { continuation?: boolean }): { text: string; sectionSizes: Record<string, number>; providedPaths?: readonly string[] } & RenderedPromptFacts {
    return opts?.continuation ? this.b.buildPromptAssembled(input, { continuation: true }) : this.b.buildPromptAssembled(input);
  }

  renderReviewer(input: ReviewInput): { text: string; sectionSizes: Record<string, number> } & RenderedPromptFacts {
    return this.b.buildReviewerPromptAssembled(input);
  }

  specFileForFlow(flow: string): string {
    return this.b.specFileForFlow(flow);
  }

  render(sections: readonly { heading: string; body: string }[]): string {
    return sections.map((s) => `# ${s.heading}\n\n${s.body}`).join("\n\n");
  }
}
