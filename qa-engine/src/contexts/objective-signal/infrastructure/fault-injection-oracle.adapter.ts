/* src/contexts/objective-signal/infrastructure/fault-injection-oracle.adapter.ts ValueOraclePort for the E2E target. The pure scoring half (scoreFaultInjection/isFlowBreak) lives in ../domain/fault-injection-score.ts. The re-run corrupts only the operations the change reaches (the aim); without an aim there is nothing to corrupt and no score is given. Signal-only by contract: a null valueScore never gates publish. */
import type { ValueOraclePort } from "../application/ports/value-oracle.port.ts";
import type { ValueOracleResult } from "../domain/coverage-collector.ts";
import type { FaultCounterRecord } from "../domain/dump-sanitizers.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { scoreFaultInjection, type FaultAim } from "../domain/fault-injection-score.ts";

interface CorruptedRunResult {
  verdict: string;
  cases: QaCase[];
}

type RunCorrupted = (args: { dir: string; baseUrl: string; namespace: string; operations: FaultAim["operations"] }) => Promise<CorruptedRunResult>;
/* The counters the corrupted re-run left, one per test that saw a corrupted response, or undefined when they could not all be read. */
type ReadCounters = (e2eDir: string, namespace: string) => FaultCounterRecord[] | undefined;

const notMeasured = (details: string): ValueOracleResult => ({
  valueScore: null,
  /* null, not 0 — "not measured", never a fabricated zero mutant/kill count. */
  mutantCount: null,
  killedCount: null,
  details,
});

export class FaultInjectionOracleAdapter implements ValueOraclePort {
  constructor(
    private readonly runCorrupted: RunCorrupted,
    private readonly readCounters: ReadCounters,
    private readonly baseUrl: string,
  ) {}

  async measure(br: BlastRadius, repoDir: string, namespace: string, baselineCases?: string[], aim?: FaultAim): Promise<ValueOracleResult> {
    if (!repoDir || !this.baseUrl || !baselineCases || baselineCases.length === 0) {
      return notMeasured("fault-injection needs e2eDir + baseUrl + baseline-passing specs");
    }
    /* Nothing is corrupted that the change does not reach: with no operation in reach, or no scope to read it from, the re-run does not start. */
    if (aim === undefined || aim.operations.length === 0) {
      return notMeasured("no operation of the change is in reach (or the run has no change scope): the corrupted re-run was not started and no score is given");
    }
    const fiNamespace = `${namespace}-fi`;
    const run = await this.runCorrupted({ dir: repoDir, baseUrl: this.baseUrl, namespace: fiNamespace, operations: aim.operations });
    if (run.verdict === "infra-error") {
      return notMeasured("fault-injection re-run inconclusive (infra)");
    }
    /* mutation-scope:begin injected-count-read */
    const counters = this.readCounters(repoDir, fiNamespace);
    if (counters === undefined) {
      return notMeasured("the corrupted re-run's counters could not all be read — fault-injection is inconclusive (no score)");
    }
    if (counters.reduce((sum, record) => sum + record.corrupted, 0) === 0) {
      return notMeasured("no JSON response of an operation in reach was intercepted — fault-injection is not applicable to this app's flows (no score)");
    }
    /* mutation-scope:end injected-count-read */
    const ranCorrupted = new Set(run.cases.map((c) => c.name));
    const scoreable = baselineCases.filter((n) => ranCorrupted.has(n));
    if (scoreable.length === 0) {
      return notMeasured("the corrupted re-run executed none of the baseline-passing specs (inconclusive)");
    }
    const score = scoreFaultInjection({ baselinePass: scoreable, corrupted: run.cases, counters, aim });
    return {
      valueScore: score.valueScore,
      mutantCount: score.exposed,
      killedCount: score.killed,
      details: score.exposed === 0
        ? "no baseline-passing spec was exposed to a corrupted response of an operation in reach (no score)"
        : `${score.killed}/${score.exposed} baseline-passing specs exposed to a corrupted response of an operation in reach noticed it (response-oracle catch-rate)`,
      perCandidate: score.perCandidate,
    };
  }
}
