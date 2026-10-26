/* A prompt is a list of section definitions: each declares the section it is, when it applies to a turn's context and how it renders from it. Assembly filters by `applies`, renders what remains and hands the result to the assembler. Never import src/. */

import { section, type Section, type SectionOpts, type SectionRole } from "./context-assembler.ts";

/* What a section renders: its text, and the options that bound or describe it. */
export interface SectionRender extends Pick<SectionOpts, "claims" | "itemIds" | "omissions" | "maxBytes" | "overflow" | "shedAs" | "cacheable" | "language"> {
  content: string;
}

export interface PromptSectionDef<C> {
  id: string;
  tier: SectionRole;
  priority: number;
  /* Whether the section belongs in the prompt of this turn. A section that does not apply renders nothing and leaves no size, claim or item in the assembled prompt. */
  applies(ctx: C): boolean;
  render(ctx: C): SectionRender;
}

/* The sections of one turn, in registry order. */
export function renderSections<C>(defs: readonly PromptSectionDef<C>[], ctx: C): Section[] {
  return defs
    .filter((def) => def.applies(ctx))
    .map((def) => {
      const { content, ...opts } = def.render(ctx);
      return section(def.id, def.tier, content, { priority: def.priority, ...opts });
    });
}
