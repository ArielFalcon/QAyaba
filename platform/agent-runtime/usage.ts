/*
 * Per-run token/cost usage shapes — observation-only; never influences verdict or publish.
 * A snapshot is OpenCode SDK info.tokens + info.cost from one session.prompt response; the sum over a run is a
 * RunUsage, persisted on gateSignals.usage. A run with no usage snapshot has none (never zero).
 */

/* A single SDK response's normalized token counts + optional cost. */
export interface UsageSnapshot {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;  /* SDK-computed; 0 when the model's rate config is absent from opencode.json */
}

/*
 * The persisted shape on RunOutcome.gateSignals.usage.
 * total = input + output + reasoning (reasoning is the semantic spend, not cache).
 * cost is absent when no snapshot fired (a zero cost is never invented).
 * complete: true iff both primary and reviewer are OpenCode in this run config.
 * primaryProvider / reviewerProvider: the provider names from the role assignment at run time,
 * persisted for attribution (e.g. "opencode"). Absent when no runtime config is known.
 */
export interface RunUsage {
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;  /* = input + output + reasoning */
  };
  cost?: number;  /* USD, SDK-computed; present iff >= 1 snapshot fired */
  complete: boolean;  /* true = full picture; false = partial */
  primaryProvider?: string;  /* provider for the primary/generator role (e.g. "opencode") */
  reviewerProvider?: string;  /* provider for the reviewer role (e.g. "opencode") */
}
