/* Generation ports. PromptBudgetPort is the generation-side capDiff/capText concern, separate from kernel RedactionPort. The use-case always receives a DomGroundingPort — code-mode uses a null adapter, never undefined. */

import type { Objective } from "@kernel/objective.ts";
import type { QaCase, SpecMeta } from "@kernel/qa-case.ts";
import type { OpencodeRunInput, ReviewInput, ParallelWorkerInput, ExplorationBrief } from "./generation-ports.ts";
import type { ManifestEntry } from "@kernel/manifest/manifest-entry.ts";
export type { ManifestEntry };
export interface ManifestRepositoryPort {
  read(specDir: string): Promise<ManifestEntry[]>;
  reconcile(specDir: string, entries: readonly ManifestEntry[]): Promise<ManifestEntry[]>;
}

/** Free-form LLM text → structured deliverable. Fail-closed on an unparseable verdict. parsed is FALSE only on a parse miss, not a deliberate no-op. specMetas drives the disk-reconciled manifest upsert (disk over the agent's word). noopReason is the generator's stated reason for writing nothing (never inferred from `approved`); outputTail is the end of the agent's output. Both are already redacted and bounded to the note limit. */
export interface GeneratorDeliverable { specs: string[]; note?: string; parsed?: boolean; specMetas?: SpecMeta[]; noopReason?: string; outputTail?: string; }
export interface ReviewJudgment {
  approved: boolean;
  corrections: string[];
  rationale?: string;
  blockingCount?: number;
  parsed?: boolean;
  valid: boolean;
  issues: string[];
}
export interface VerdictParserPort {
  /* With the run's specDir, a bare spec file name the agent reported resolves to the one suite spec of that name (suite-relative); without it, names are kept as reported. */
  parseGenerator(text: string, specDir?: string): GeneratorDeliverable;
  parseReview(text: string): ReviewJudgment;
}

export interface PromptSection { heading: string; body: string; }
export interface PromptRenderingPort {
  render(sections: readonly PromptSection[]): string;
  renderMain(input: OpencodeRunInput): { text: string; sectionSizes: Record<string, number>; providedPaths?: readonly string[] };
  renderWorker(w: ParallelWorkerInput): { text: string; sectionSizes: Record<string, number> };
  renderReviewer(input: ReviewInput): { text: string; sectionSizes: Record<string, number> };
  renderExplorer(input: OpencodeRunInput): string;
  specFileForFlow(flow: string): string;
}

/** e2e: real grounding; code-mode: NullDomGroundingAdapter returns an empty context (code mode has no browser). */
export interface DomGrounding { aria: string; routes: string[]; }
export interface DomGroundingPort {
  ground(objective: Objective): Promise<DomGrounding>;
}

/** capDiff/capText prompt-budget capping — a generation concern, NOT redaction. budgetForRole resolves the per-role byte budget (model → window → bytes) from the catalog; the adapter FORWARDS roleWindowBytes(role) — the port carries no threshold, the catalog owns it. */
export interface PromptBudgetPort {
  capDiff(diff: string): string;
  capText(text: string): string;
  budgetForRole(role: string): number;
}

export interface ContextPackResult { objective: Objective; sections: PromptSection[]; failureCases?: QaCase[]; }

export interface PlanObjectiveView {
  flow: string;
  objective: string;
  reason?: string;
  symbols: string[];     /* code symbols the spec should exercise (serena blast radius) */
  needsUi: boolean;
  brief?: ExplorationBrief; /* distilled blast radius so the worker need not re-explore (optional → back-compat) */
}
export interface PlanParserPort { parse(text: string): PlanObjectiveView[]; }
