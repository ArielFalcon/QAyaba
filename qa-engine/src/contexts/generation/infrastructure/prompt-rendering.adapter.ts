import type { ContextBudget } from "@kernel/context-budget.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import type { RenderedPromptFacts } from "../domain/prompt-facts.ts";
import type { PromptRenderingPort } from "../application/ports/prompt-rendering.port.ts";
import type { OpencodeRunInput } from "../domain/opencode-run-input.ts";
import type { ReviewInput } from "../domain/generation-input.ts";

/* What the builders are told about the run's windows: the window of a role, in tokens; absent or unknown, a prompt is not cut for it. */
export interface PromptWindows {
  windowTokens?: (role: AgentRole) => number | undefined;
}

type Rendered = { text: string; sectionSizes: Record<string, number> } & RenderedPromptFacts;

export interface PromptBuilders {
  buildPromptAssembled(input: OpencodeRunInput, opts?: PromptWindows): Rendered & { providedPaths?: readonly string[]; promptRole?: "lead" | "author" };
  buildReviewerPromptAssembled(input: ReviewInput, opts?: PromptWindows): Rendered;
  specFileForFlow(flow: string): string;
}

export class PromptRenderingAdapter implements PromptRenderingPort {
  /* `contextBudget` is the run's: absent (a host with no window source), no prompt is cut for a window and none records a fit. */
  constructor(
    private readonly b: PromptBuilders,
    private readonly contextBudget?: ContextBudget,
  ) {}

  private windows(): PromptWindows {
    const budget = this.contextBudget;
    return budget ? { windowTokens: (role) => budget.windowTokens(role) } : {};
  }

  /* The prompt's size against its role's window, with the working room its turn needs. */
  private withFit<T extends Rendered>(rendered: T, role: AgentRole): T {
    if (!this.contextBudget) return rendered;
    return { ...rendered, contextFit: this.contextBudget.fit({ prompt: { bytes: Buffer.byteLength(rendered.text, "utf8") }, role }) };
  }

  renderMain(input: OpencodeRunInput): { text: string; sectionSizes: Record<string, number>; providedPaths?: readonly string[] } & RenderedPromptFacts {
    const rendered = this.b.buildPromptAssembled(input, this.windows());
    return this.withFit(rendered, rendered.promptRole ?? "author");
  }

  renderReviewer(input: ReviewInput): { text: string; sectionSizes: Record<string, number> } & RenderedPromptFacts {
    return this.withFit(this.b.buildReviewerPromptAssembled(input, this.windows()), "reviewer");
  }

  specFileForFlow(flow: string): string {
    return this.b.specFileForFlow(flow);
  }

  render(sections: readonly { heading: string; body: string }[]): string {
    return sections.map((s) => `# ${s.heading}\n\n${s.body}`).join("\n\n");
  }
}
