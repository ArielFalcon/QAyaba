import type { PromptClaim } from "@contexts/generation/domain/prompt-contract-lint.ts";
import type { Omission, SectionMeta } from "@kernel/telemetry/section-meta.ts";

export type SectionRole = "stable-prefix" | "semi-stable" | "volatile" | "task" | "critical-recap";

export interface Section {
  id: string;
  role: SectionRole;
  priority: number;
  maxBytes: number;
  content: string | (() => string);
  stability?: "static" | "run";
  overflow: "summarize" | "drop";
  language: "scaffold" | "verbatim";
  shedAs?: SectionRole;
  claims?: readonly PromptClaim[];
  /* Stable ids of the grounding items this section supplies (context-item-ids.ts). Absent for a section that supplies none. */
  itemIds?: readonly string[];
  /* The items this section chose to leave out, before the assembler's own cap/shed. */
  omissions?: readonly Omission[];
}

export interface AssembledPrompt {
  text: string;
  sectionSizes: Record<string, number>;
  claims: Record<string, readonly PromptClaim[]>;
  /* What each grounding section supplied and lost, from the kept assembly: its item ids, its omissions and whether the assembler capped it. Keyed by section id. */
  sectionItems: Record<string, SectionMeta>;
  providedPaths?: readonly string[];
  sectionHashes?: Record<string, string>;
  droppedSections?: readonly string[];
  budgetBytes?: number;
  stablePrefixBytes: number;
}

export type SectionOpts = Partial<Pick<Section, "priority" | "maxBytes" | "stability" | "overflow" | "language" | "shedAs" | "claims" | "itemIds" | "omissions">>;

export interface AssembleOpts {
  budgetBytes?: number;
}

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
