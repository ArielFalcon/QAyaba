import type { AssembleOpts, AssembledPrompt, Section, SectionOpts, SectionRole } from "@kernel/prompt-sections.ts";

export type { AssembleOpts, AssembledPrompt, Section, SectionOpts, SectionRole };

type AssembleFn = (sections: Section[], opts: AssembleOpts) => AssembledPrompt;
type SectionFn = (
  id: string,
  role: SectionRole,
  content: string | (() => string),
  opts?: SectionOpts,
) => Section;

export class ContextAssemblerAdapter {
  constructor(
    private readonly assembleFn: AssembleFn,
    private readonly sectionFn: SectionFn,
  ) {}

  assemble(sections: Section[], opts: AssembleOpts = {}): AssembledPrompt {
    return this.assembleFn(sections, opts);
  }

  section(
    id: string,
    role: SectionRole,
    content: string | (() => string),
    opts?: SectionOpts,
  ): Section {
    return this.sectionFn(id, role, content, opts);
  }
}
