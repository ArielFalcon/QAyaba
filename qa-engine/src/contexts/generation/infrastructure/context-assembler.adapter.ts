
export type SectionRole = "stable-prefix" | "semi-stable" | "volatile" | "task" | "critical-recap";

export interface Section {
  id: string;
  role: SectionRole;
  priority: number;
  maxBytes: number;
  content: string | (() => string);
  cacheable?: boolean;
  overflow: "summarize" | "drop";
  language: "scaffold" | "verbatim";
  shedAs?: SectionRole;
}

export interface AssembledPrompt {
  text: string;
  sectionSizes: Record<string, number>;
}

export interface AssembleOpts {
  budgetBytes?: number;
}

type AssembleFn = (sections: Section[], opts: AssembleOpts) => AssembledPrompt;
type SectionFn = (
  id: string,
  role: SectionRole,
  content: string | (() => string),
  opts?: Partial<Pick<Section, "priority" | "maxBytes" | "cacheable" | "overflow" | "language" | "shedAs">>,
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
    opts?: Partial<Pick<Section, "priority" | "maxBytes" | "cacheable" | "overflow" | "language" | "shedAs">>,
  ): Section {
    return this.sectionFn(id, role, content, opts);
  }
}
