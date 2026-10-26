import type { Sha } from "@kernel/sha.ts";
import type { RelevanceBias } from "@contexts/cross-run-learning/domain/rule-governance.service.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { LearningRule } from "../../domain/learning-repository.ts";

export interface LearningRepositoryPort {
  save(rule: LearningRule): Promise<void>;
  topRules(app: string, sha: Sha, limit: number, relevance?: RelevanceBias): Promise<LearningRule[]>;
  applyOutcome(outcome: RunOutcome): Promise<void>;
  incrementUsage?(ids: readonly string[]): Promise<void>;
  /* Optional (same optionality convention as incrementUsage above) so a caller/fake/store that never distills need not implement it. A store/fake that still omits selectAllRules remains a fail-open no-op (empty existing set), never a stricter gate than before this method existed — that fallback is preserved for tests only now. */
  listAll?(app: string, limit: number): Promise<LearningRule[]>;
}
