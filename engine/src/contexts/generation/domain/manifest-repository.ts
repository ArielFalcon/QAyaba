import type { SpecMeta } from "@kernel/qa-case.ts";
import type { NoopKind } from "@kernel/noop-kind.ts";
import type { ReviewFinding } from "./review-output.ts";

/** Free-form LLM text → structured deliverable. Fail-closed on an unparseable verdict. parsed is FALSE only on a parse miss, not a deliberate no-op. specMetas drives the disk-reconciled manifest upsert (disk over the agent's word). noopReason is the generator's stated reason for writing nothing (never inferred from `approved`); outputTail is the end of the agent's output. Both are already redacted and bounded to the note limit. */
export interface GeneratorDeliverable { specs: string[]; note?: string; parsed?: boolean; specMetas?: SpecMeta[]; noopReason?: string; noopKind?: NoopKind; outputTail?: string; explore?: unknown[]; testCorrect?: { cause: "env" | "app"; reason: string }; rebuttals?: { finding: string; basis: "execution" | "contract"; ref: string; reason: string }[]; }

export interface ReviewJudgment {
  approved: boolean;
  findings: ReviewFinding[];
  rationale?: string;
  blockingCount?: number;
  parsed?: boolean;
  /* The answer was readable whole: only then are `approved` and `findings` the reviewer's word. */
  valid: boolean;
  /* What the engine could not read, or read and set aside; empty when nothing was lost. */
  issues: string[];
}

export interface PromptSection { heading: string; body: string; }
