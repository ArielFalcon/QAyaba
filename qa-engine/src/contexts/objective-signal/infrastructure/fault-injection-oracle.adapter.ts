/* src/contexts/objective-signal/infrastructure/fault-injection-oracle.adapter.ts ValueOraclePort for the E2E target. The pure scoring half (computeFaultInjectionScore/isFlowBreak) lives in ../domain/fault-injection-score.ts. Signal-only by contract: a null valueScore never gates publish. */
import type { ValueOraclePort, ValueOracleResult } from "../application/ports/index.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { computeFaultInjectionScore } from "../domain/fault-injection-score.ts";

interface CorruptedRunResult {
  verdict: string;
  cases: QaCase[];
}

type RunCorrupted = (args: { dir: string; baseUrl: string; namespace: string }) => Promise<CorruptedRunResult>;
type CountInjected = (e2eDir: string, namespace: string) => number;

export class FaultInjectionOracleAdapter implements ValueOraclePort {
  constructor(
    private readonly runCorrupted: RunCorrupted,
    private readonly countInjected: CountInjected,
    private readonly baseUrl: string,
  ) {}

  async measure(br: BlastRadius, repoDir: string, namespace: string, baselineCases?: string[]): Promise<ValueOracleResult> {
    if (!repoDir || !this.baseUrl || !baselineCases || baselineCases.length === 0) {
      return {
        valueScore: null,
        mutantCount: 0,
        killedCount: 0,
        details: "fault-injection needs e2eDir + baseUrl + baseline-passing specs",
      };
    }
    const fiNamespace = `${namespace}-fi`;
    const run = await this.runCorrupted({ dir: repoDir, baseUrl: this.baseUrl, namespace: fiNamespace });
    if (run.verdict === "infra-error") {
      return { valueScore: null, mutantCount: 0, killedCount: 0, details: "fault-injection re-run inconclusive (infra)" };
    }
    if (this.countInjected(repoDir, fiNamespace) === 0) {
      return {
        valueScore: null,
        mutantCount: 0,
        killedCount: 0,
        details: "no JSON responses were intercepted — fault-injection is not applicable to this app's flows (no score)",
      };
    }
    const ranCorrupted = new Set(run.cases.map((c) => c.name));
    const scoreable = baselineCases.filter((n) => ranCorrupted.has(n));
    if (scoreable.length === 0) {
      return {
        valueScore: null,
        mutantCount: 0,
        killedCount: 0,
        details: "the corrupted re-run executed none of the baseline-passing specs (inconclusive)",
      };
    }
    const { valueScore, killed, total } = computeFaultInjectionScore(scoreable, run.cases);
    return {
      valueScore,
      mutantCount: total,
      killedCount: killed,
      details: `${killed}/${total} baseline-passing specs noticed corrupted responses (response-oracle catch-rate)`,
    };
  }
}
