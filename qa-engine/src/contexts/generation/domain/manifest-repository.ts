import type { SpecMeta, QaCase } from "@kernel/qa-case.ts";
import type { NoopKind } from "@kernel/noop-kind.ts";
import type { Objective } from "@contexts/generation/domain/objective.ts";

/** Free-form LLM text → structured deliverable. Fail-closed on an unparseable verdict. parsed is FALSE only on a parse miss, not a deliberate no-op. specMetas drives the disk-reconciled manifest upsert (disk over the agent's word). noopReason is the generator's stated reason for writing nothing (never inferred from `approved`); outputTail is the end of the agent's output. Both are already redacted and bounded to the note limit. */
export interface GeneratorDeliverable { specs: string[]; note?: string; parsed?: boolean; specMetas?: SpecMeta[]; noopReason?: string; noopKind?: NoopKind; outputTail?: string; plan?: Record<string, unknown>; explore?: unknown[]; testCorrect?: { cause: "env" | "app"; reason: string }; rebuttals?: { finding: string; basis: "execution" | "contract"; ref: string; reason: string }[]; }

export interface ReviewJudgment {
  approved: boolean;
  corrections: string[];
  rationale?: string;
  blockingCount?: number;
  parsed?: boolean;
  valid: boolean;
  issues: string[];
  /* The reviewer's own severity per correction, in order, when it stated one. */
  severities?: ("blocking" | "advisory")[];
  /* The evidence each correction cites, in order; a hole means that entry cited none. */
  citations?: ({ kind: "contract" | "execution" | "dom" | "arm" | "availability" | "contradiction"; ref: string } | undefined)[];
}

export interface PromptSection { heading: string; body: string; }

/** e2e: real grounding; code-mode: NullDomGroundingAdapter returns an empty context (code mode has no browser). */
export interface DomGrounding { aria: string; routes: string[]; }

export interface ContextPackResult { objective: Objective; sections: PromptSection[]; failureCases?: QaCase[]; }

export interface PlanObjectiveView {
  flow: string;
  objective: string;
  reason?: string;
  symbols: string[];     /* code symbols the spec should exercise (serena blast radius) */
  needsUi: boolean;
}
