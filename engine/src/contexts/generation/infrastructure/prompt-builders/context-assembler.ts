/* The generation context's entry to the prompt engine (`shared-kernel/prompt-sections.ts`), wrapped by the assembler adapter. */
import { ContextAssemblerAdapter } from "@contexts/generation/infrastructure/context-assembler.adapter.ts";
import { assembleSections, makeSection } from "@kernel/prompt-sections.ts";
import type { AssembleOpts, AssembledPrompt, Section, SectionOpts, SectionRole } from "@kernel/prompt-sections.ts";

export type { AssembleOpts, AssembledPrompt, Section, SectionOpts, SectionRole };

const defaultAssembler = new ContextAssemblerAdapter(assembleSections, makeSection);

export function assemble(sections: Section[], opts: AssembleOpts = {}): AssembledPrompt {
  return defaultAssembler.assemble(sections, opts);
}

export function section(
  id: string,
  role: SectionRole,
  content: string | (() => string),
  opts: SectionOpts = {},
): Section {
  return defaultAssembler.section(id, role, content, opts);
}
