/*
 * Runs LLM judges over finished runs (docs/observability-design.md section 11.3). The shell calls it from a low-priority job on the
 * sequential queue, so it never overlaps a run. It reads stored evidence only, asks the tool-less judge role one question per
 * (run, judge), and stores a `source=llm_judge` score for an answer that parses exactly. It is fail-open and inert: it never
 * throws, never changes a verdict, a decision or a run's evaluation status, and it stops before a call that would pass the day's
 * token budget. A judge is an opinion; nothing here, or anywhere, gates on it.
 */

import { engineLog } from "@kernel/ports/process-logger.ts";
import { judgeDefinition, judgeScore, buildJudgeInput, parseJudgeOutput, judgeGraderVersion, type JudgeName } from "../domain/judges.ts";
import type { JudgeAgentPort } from "./ports/judge-agent.port.ts";
import type { JudgeAttempt, JudgeOutcome } from "../domain/judge-evidence.ts";
import type { JudgeEvidencePort } from "./ports/judge-evidence.port.ts";
import type { JudgeLedgerPort } from "./ports/judge-ledger.port.ts";
import type { ScoreStorePort } from "./ports/score-store.port.ts";

export interface RunJudgesDeps {
  evidence: JudgeEvidencePort;
  agent: JudgeAgentPort;
  store: ScoreStorePort;
  ledger: JudgeLedgerPort;
  /* The version of the pinned judge prompt in force. */
  promptVersion: string;
  /* The model the judge role is configured with, recorded when the runtime does not say which one answered. */
  configuredModel?: string;
  /* The most tokens judges may use per UTC day. */
  dailyTokenBudget: number;
  /* The outbound prompt redaction; a text it refuses is never sent. */
  sanitize: (text: string) => string;
  /* Wall-clock ISO-8601 now. */
  now: () => string;
  log?: (message: string) => void;
}

export interface JudgeWorkItem {
  runId: string;
  judge: JudgeName;
}

export interface JudgeBatchResult {
  scored: number;
  unparseable: number;
  notApplicable: number;
  errors: number;
  /* Already answered at this prompt version. */
  skipped: number;
  /* Why the batch ended early, when it did. */
  stopped?: "budget" | "yield" | "aborted";
  /* The items not attempted because the batch stopped. */
  remaining: JudgeWorkItem[];
}

/* The rough size of a call when the runtime reports no tokens: four bytes a token, plus room for the answer. */
const BYTES_PER_TOKEN = 4;
const ANSWER_ALLOWANCE_TOKENS = 600;

export function estimateJudgeTokens(prompt: string, output: string): number {
  return Math.ceil((Buffer.byteLength(prompt, "utf8") + Buffer.byteLength(output, "utf8")) / BYTES_PER_TOKEN) + ANSWER_ALLOWANCE_TOKENS;
}

/* An answer already given at this prompt version is not asked for again; an error is the only outcome worth retrying. */
const FINAL: readonly JudgeOutcome[] = ["scored", "unparseable", "not_applicable"];

const MAX_DETAIL_CHARS = 300;

export class RunJudgesUseCase {
  /* The estimated size of the call in flight, charged when it fails. Batches are sequential, so one field is enough. */
  private lastEstimate = 0;

  constructor(private readonly deps: RunJudgesDeps) {}

  async execute(work: readonly JudgeWorkItem[], opts: { force?: boolean; signal?: AbortSignal; shouldYield?: () => boolean } = {}): Promise<JudgeBatchResult> {
    const result: JudgeBatchResult = { scored: 0, unparseable: 0, notApplicable: 0, errors: 0, skipped: 0, remaining: [] };
    const log = this.deps.log ?? ((m: string) => engineLog.error(m));
    for (let i = 0; i < work.length; i += 1) {
      const stop = opts.signal?.aborted ? "aborted" : opts.shouldYield?.() ? "yield" : undefined;
      if (stop) return this.stop(result, work, i, stop);
      const item = work[i]!;
      try {
        const outcome = await this.judgeOne(item, opts, result);
        if (outcome === "budget") return this.stop(result, work, i, "budget");
      } catch (err) {
        /* The call was cut by an abort (a run arrived, or a shutdown): not a fault of the judge, and the item is still to do. */
        if (opts.signal?.aborted) return this.stop(result, work, i, "aborted");
        result.errors += 1;
        log(`[judge] ${item.judge} on ${item.runId} failed: ${err instanceof Error ? err.message : String(err)}`);
        /* The provider may have spent tokens on a call that failed: the day's budget is charged the estimate. */
        this.tryRecord(item, "error", this.lastEstimate, null, err instanceof Error ? err.message : String(err));
      }
    }
    return result;
  }

  private stop(result: JudgeBatchResult, work: readonly JudgeWorkItem[], from: number, reason: "budget" | "yield" | "aborted"): JudgeBatchResult {
    return { ...result, stopped: reason, remaining: work.slice(from) };
  }

  private async judgeOne(item: JudgeWorkItem, opts: { force?: boolean; signal?: AbortSignal }, result: JudgeBatchResult): Promise<"done" | "budget"> {
    const { evidence, agent, store, ledger, promptVersion, now } = this.deps;
    const prior = ledger.lastOutcome(item.runId, item.judge, promptVersion);
    if (!opts.force && prior !== undefined && FINAL.includes(prior)) {
      result.skipped += 1;
      return "done";
    }
    const def = judgeDefinition(item.judge);
    const found = evidence.load(item.runId);
    if (!found) {
      /* Not remembered: a run that is not finished yet may be judged once it is. */
      result.notApplicable += 1;
      return "done";
    }
    const input = buildJudgeInput(item.judge, found, this.deps.sanitize);
    if (!input.ok) return this.notApplicable(item, input.reason, result);

    /* The day's budget is checked against what this call is expected to cost, before it is sent. */
    const day = now().slice(0, 10);
    const estimate = estimateJudgeTokens(input.text, "");
    if (ledger.tokensUsedOn(day) + estimate > this.deps.dailyTokenBudget) return "budget";
    this.lastEstimate = estimate;

    const answer = await agent.ask(input.text, opts.signal);
    const spent = answer.tokens ?? estimateJudgeTokens(input.text, answer.output);
    const model = answer.model ?? this.deps.configuredModel ?? "unknown";
    const parsed = parseJudgeOutput(def, answer.output);
    if (!parsed.ok) {
      result.unparseable += 1;
      (this.deps.log ?? ((m: string) => engineLog.error(m)))(`[judge] ${item.judge} on ${item.runId}: unparseable reply (${parsed.reason}); no score`);
      ledger.record(this.attempt(item, "unparseable", spent, model, parsed.reason));
      return "done";
    }
    const score = judgeScore(def, parsed, { promptVersion, model });
    store.replace(item.runId, [score], now(), { graderVersion: judgeGraderVersion(item.judge, promptVersion), baseNames: [item.judge] });
    ledger.record(this.attempt(item, "scored", spent, model, null));
    result.scored += 1;
    return "done";
  }

  private notApplicable(item: JudgeWorkItem, reason: string, result: JudgeBatchResult): "done" {
    result.notApplicable += 1;
    this.deps.ledger.record(this.attempt(item, "not_applicable", 0, null, reason));
    return "done";
  }

  private attempt(item: JudgeWorkItem, outcome: JudgeOutcome, tokens: number, model: string | null, detail: string | null): JudgeAttempt {
    return { runId: item.runId, judge: item.judge, promptVersion: this.deps.promptVersion, model, outcome, tokens, detail: detail === null ? null : detail.slice(0, MAX_DETAIL_CHARS), at: this.deps.now() };
  }

  /* A ledger that cannot be written is said, never allowed to hide the original fault. */
  private tryRecord(item: JudgeWorkItem, outcome: JudgeOutcome, tokens: number, model: string | null, detail: string): void {
    try {
      this.deps.ledger.record(this.attempt(item, outcome, tokens, model, detail));
    } catch (err) {
      (this.deps.log ?? ((m: string) => engineLog.error(m)))(`[judge] could not record the attempt of ${item.runId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
